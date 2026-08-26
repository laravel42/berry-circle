// Package orchestrationtest runs automation orchestrations on the Temporal
// test suite behind the client seam the starter uses, so handler and
// dispatcher tests exercise the Temporal path — the real starter, the real
// orchestration, the real activities — without a Temporal server.
//
// The test suite executes one workflow per environment and blocks the
// caller until it finishes, which a run parked on a person never does on
// its own. The client therefore runs each orchestration on its own
// goroutine and makes every start and signal return once the orchestration
// is idle again: its activity has recorded the run's outcome, or the
// workflow has completed. A test that ticks the dispatcher sees the run's
// rows exactly as the in-process starter would have left them.
package orchestrationtest

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	temporallog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"github.com/laravel42/berry-circle/server/internal/orchestration"
)

// Client is an orchestration.AutomationClient over the test suite.
type Client struct {
	mu         sync.Mutex
	suite      *testsuite.WorkflowTestSuite
	activities *orchestration.Activities
	executions map[string]*execution
	starts     int
}

// NewClient prepares a client whose orchestrations call the given
// activities. Only the automation activities are registered; the intake and
// run activities never execute here.
func NewClient(activities *orchestration.Activities) *Client {
	suite := &testsuite.WorkflowTestSuite{}
	suite.SetLogger(temporallog.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil))))
	return &Client{suite: suite, activities: activities, executions: map[string]*execution{}}
}

// ExecuteWorkflow starts an orchestration, or reports the one already
// running for the id exactly as the server does.
func (c *Client) ExecuteWorkflow(
	_ context.Context,
	options client.StartWorkflowOptions,
	workflowType interface{},
	args ...interface{},
) (client.WorkflowRun, error) {
	c.mu.Lock()
	if running, ok := c.executions[options.ID]; ok && !running.finished() {
		c.mu.Unlock()
		return nil, serviceerror.NewWorkflowExecutionAlreadyStarted("workflow execution already started", "", options.ID)
	}
	exec := c.start(options.ID, workflowType, args, 1)
	c.mu.Unlock()
	exec.waitIdle()
	return handle{id: options.ID, exec: exec}, nil
}

// SignalWorkflow delivers a signal to a running orchestration.
func (c *Client) SignalWorkflow(_ context.Context, workflowID, _ string, signalName string, arg interface{}) error {
	c.mu.Lock()
	exec, ok := c.executions[workflowID]
	if !ok || exec.finished() {
		c.mu.Unlock()
		return serviceerror.NewNotFound("workflow execution not found")
	}
	c.mu.Unlock()
	exec.signal(signalName, arg)
	exec.waitIdle()
	return nil
}

// SignalWithStartWorkflow signals the running orchestration, or starts one
// and delivers the signal to it.
func (c *Client) SignalWithStartWorkflow(
	_ context.Context,
	workflowID, signalName string,
	signalArg interface{},
	_ client.StartWorkflowOptions,
	workflowType interface{},
	workflowArgs ...interface{},
) (client.WorkflowRun, error) {
	c.mu.Lock()
	exec, ok := c.executions[workflowID]
	if !ok || exec.finished() {
		exec = c.start(workflowID, workflowType, workflowArgs, 1)
	}
	c.mu.Unlock()
	exec.signal(signalName, signalArg)
	exec.waitIdle()
	return handle{id: workflowID, exec: exec}, nil
}

// Starts counts the orchestrations this client actually started.
func (c *Client) Starts() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.starts
}

// Running reports whether an orchestration with the id is still open.
func (c *Client) Running(workflowID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	exec, ok := c.executions[workflowID]
	return ok && !exec.finished()
}

// Wait blocks until the orchestration completes and returns its error.
func (c *Client) Wait(workflowID string) error {
	c.mu.Lock()
	exec, ok := c.executions[workflowID]
	c.mu.Unlock()
	if !ok {
		return errors.New("orchestrationtest: no such workflow " + workflowID)
	}
	<-exec.done
	return exec.err
}

// Close cancels every orchestration still open. Register it with
// t.Cleanup so a run left parked by a test does not outlive it.
func (c *Client) Close() {
	c.mu.Lock()
	open := make([]*execution, 0, len(c.executions))
	for _, exec := range c.executions {
		if !exec.finished() {
			open = append(open, exec)
		}
	}
	c.mu.Unlock()
	for _, exec := range open {
		exec.env.CancelWorkflow()
		select {
		case <-exec.done:
		case <-time.After(5 * time.Second):
		}
	}
}

// start runs a new environment for the id. pending is how many step
// activities must complete before the orchestration is idle: one for the
// start itself, one more for each signal delivered before it.
func (c *Client) start(workflowID string, workflowType interface{}, args []interface{}, pending int) *execution {
	env := c.suite.NewTestWorkflowEnvironment()
	// A run parked on a person is idle by design; the test decides when it
	// ends. The suite would otherwise end it two ways: it fails a workflow
	// idle for longer than its test timeout, and whenever the workflow is
	// idle it skips the mock clock to the next timer — the run timeout it
	// registers by default — which completes the workflow with a deadline
	// error. Neither may happen here, so the first is pushed out and the
	// second is not registered at all.
	env.SetTestTimeout(time.Hour)
	env.SetWorkflowRunTimeout(0)
	env.RegisterWorkflowWithOptions(orchestration.AutomationOrchestration, workflow.RegisterOptions{Name: orchestration.AutomationOrchestrationName})
	exec := &execution{env: env, done: make(chan struct{}), started: make(chan struct{}), pending: pending}
	exec.cond = sync.NewCond(&exec.mu)
	env.RegisterActivityWithOptions(func(ctx context.Context, runID string) (orchestration.AutomationRunState, error) {
		exec.began()
		state, err := c.activities.ExecuteAutomationRun(ctx, runID)
		exec.completed(state, err)
		return state, err
	}, activity.RegisterOptions{Name: "ExecuteAutomationRun"})
	env.RegisterActivityWithOptions(func(ctx context.Context, runID string, resume orchestration.AutomationResume) (orchestration.AutomationRunState, error) {
		exec.began()
		state, err := c.activities.ResumeAutomationRun(ctx, runID, resume)
		exec.completed(state, err)
		return state, err
	}, activity.RegisterOptions{Name: "ResumeAutomationRun"})
	env.RegisterActivityWithOptions(func(ctx context.Context, runID, reason string) error {
		return c.activities.FailAutomationRun(ctx, runID, reason)
	}, activity.RegisterOptions{Name: "FailAutomationRun"})
	c.executions[workflowID] = exec
	c.starts++
	go func() {
		env.ExecuteWorkflow(workflowType, args...)
		exec.mu.Lock()
		exec.err = env.GetWorkflowError()
		exec.complete = true
		exec.cond.Broadcast()
		exec.mu.Unlock()
		close(exec.done)
	}()
	// A signal posted before the first workflow task would reach an
	// environment with no handler yet; the first activity proves the task ran.
	select {
	case <-exec.started:
	case <-exec.done:
	}
	return exec
}

// execution is one orchestration on its own environment.
type execution struct {
	env     *testsuite.TestWorkflowEnvironment
	done    chan struct{}
	started chan struct{}
	err     error

	mu        sync.Mutex
	cond      *sync.Cond
	once      sync.Once
	pending   int
	settling  bool
	complete  bool
	cancelled bool
}

func (exec *execution) began() {
	exec.once.Do(func() { close(exec.started) })
}

func (exec *execution) completed(state orchestration.AutomationRunState, err error) {
	exec.mu.Lock()
	defer exec.mu.Unlock()
	exec.pending--
	if err != nil || state.Terminal {
		exec.settling = true
	}
	exec.cond.Broadcast()
}

func (exec *execution) finished() bool {
	exec.mu.Lock()
	defer exec.mu.Unlock()
	return exec.complete
}

// signal posts one signal. A resume is answered by one more step activity;
// a cancel ends the workflow, so idleness then means completion.
func (exec *execution) signal(name string, arg interface{}) {
	exec.mu.Lock()
	switch name {
	case orchestration.AutomationResumeSignal:
		exec.pending++
	case orchestration.AutomationCancelSignal:
		exec.settling = true
	}
	exec.mu.Unlock()
	exec.env.SignalWorkflow(name, arg)
}

// waitIdle returns once every expected activity has completed and, when the
// last one ended the run, once the workflow has completed too.
func (exec *execution) waitIdle() {
	exec.mu.Lock()
	defer exec.mu.Unlock()
	for !exec.complete && (exec.pending > 0 || exec.settling) {
		exec.cond.Wait()
	}
}

// handle is the client.WorkflowRun the starter receives and ignores.
type handle struct {
	id   string
	exec *execution
}

func (run handle) GetID() string                  { return run.id }
func (run handle) GetRunID() string               { return "" }
func (run handle) GetFirstExecutionRunID() string { return "" }
func (run handle) Get(ctx context.Context, _ interface{}) error {
	select {
	case <-run.exec.done:
		return run.exec.err
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (run handle) GetWithOptions(ctx context.Context, valuePtr interface{}, _ client.WorkflowRunGetOptions) error {
	return run.Get(ctx, valuePtr)
}
