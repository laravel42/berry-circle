// Package automationrun executes workflows (Go noun: automation) natively.
//
// A Runner walks one run through its definition: it opens each step on the
// run ledger, hands it to the executor for its type, records the outcome,
// and parks the run when a step waits on a person, an agent run, an issue, a
// timer or an event. The trigger dispatcher resumes parked runs by handing
// the Runner a signal; the same walk continues from the rows, so a run that
// resumes on another replica sees exactly what the first one recorded.
//
// Nothing here retries a step. Every executor is either idempotent on its
// own rows or an unsafe call (a provider action, a model turn) that must not
// be repeated by a loop, so a failure is recorded and the run stops or
// continues according to the step's onError policy.
package automationrun

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

const defaultInlineTimeout = 10 * time.Minute

var (
	// ErrRunBusy means another worker in this process holds the run.
	ErrRunBusy = errors.New("automation run is executing")
	// ErrSignalMismatch means the run is not waiting on what the signal names.
	ErrSignalMismatch = errors.New("automation run is not waiting on this signal")
)

// Store is the run ledger the runner writes.
type Store interface {
	Get(context.Context, uuid.UUID) (automationrepo.Automation, error)
	GetVersion(context.Context, uuid.UUID, int) (automationrepo.Version, error)
	GetRun(context.Context, uuid.UUID) (automationrepo.Run, error)
	GetRunWithSteps(context.Context, uuid.UUID) (automationrepo.Run, []automationrepo.StepRun, error)
	CreateRun(context.Context, automationrepo.CreateRunParams) (automationrepo.Run, bool, error)
	MarkRunning(context.Context, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	MarkWaiting(context.Context, uuid.UUID, string, string, *time.Time, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	Resume(context.Context, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	CompleteSuccess(context.Context, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	Fail(context.Context, uuid.UUID, automationrepo.Failure, time.Time, func() uuid.UUID) (automationrepo.Run, automationrepo.Event, error)
	AddUsage(context.Context, uuid.UUID, automation.Usage, time.Time) error
	StartStep(context.Context, automationrepo.StartStepParams) (automationrepo.StepRun, automationrepo.Event, error)
	RecordSkippedStep(context.Context, automationrepo.StartStepParams) (automationrepo.StepRun, automationrepo.Event, error)
	CompleteStep(context.Context, uuid.UUID, json.RawMessage, *automation.Usage, automationrepo.StepLinks, time.Time, func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error)
	FailStep(context.Context, uuid.UUID, automationrepo.Failure, time.Time, func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error)
	WaitStep(context.Context, uuid.UUID, string, automationrepo.StepLinks, time.Time, func() uuid.UUID) (automationrepo.StepRun, automationrepo.Event, error)
	RecordIssueOrigin(context.Context, automationrepo.IssueOriginParams) error
	RecordAgentEvent(context.Context, automationrepo.AgentEventParams) (automationrepo.Event, error)
}

// Issues is the issue store the create_issue, update_issue and Berry tool
// steps write through: the same one the HTTP routes use.
type Issues interface {
	CreateIssue(context.Context, core.CreateIssueParams) (core.Issue, []core.IssueMutationEvent, error)
	UpdateIssue(context.Context, core.UpdateIssueParams) (core.Issue, []core.IssueMutationEvent, error)
	GetIssue(context.Context, string) (core.Issue, error)
	ListIssues(context.Context, core.IssueListFilter) ([]core.Issue, error)
	CreateComment(context.Context, core.CreateCommentParams, uuid.UUID) (core.Comment, core.CommentMutationEvent, error)
}

// Approvals records the decisions a run waits on.
type Approvals interface {
	Create(context.Context, approvals.CreateParams) (approvals.Approval, approvals.Event, error)
	Get(context.Context, uuid.UUID) (approvals.Approval, error)
}

// Goals links created issues to the run's goal and serves the Berry goal
// tools.
type Goals interface {
	Get(context.Context, uuid.UUID) (goals.Goal, error)
	Create(context.Context, goals.CreateParams) (goals.Goal, goals.Event, error)
	Update(context.Context, uuid.UUID, goals.Patch, uuid.UUID, time.Time, func() uuid.UUID) (goals.Goal, goals.Event, error)
	Transition(context.Context, uuid.UUID, goals.Status, *uuid.UUID, time.Time, func() uuid.UUID) (goals.Goal, goals.Event, error)
	Progress(context.Context, uuid.UUID) (goals.Progress, error)
	LinkIssue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error
}

// IssueRuns is the issue run admission service: an issue-mode agent step
// admits and queues a run exactly as a person would from the issue page.
type IssueRuns interface {
	Admit(context.Context, runs.AdmitParams) (runs.Run, error)
	Queue(uuid.UUID) error
	Get(context.Context, uuid.UUID) (runs.Run, error)
}

// Artifacts lists what an issue run produced, for the step's output.
type Artifacts interface {
	ListRunArtifacts(context.Context, uuid.UUID, *collaboration.AttachmentCursor, int) ([]collaboration.Attachment, error)
}

// SubrunStarter hands a child run a subworkflow step created to whatever
// executes runs. It is the Starter with the resume half left out, and it
// is set after construction because the in-process starter wraps the
// runner it serves.
type SubrunStarter interface {
	Start(ctx context.Context, runID uuid.UUID) error
}

// Responder is the one runtime call an inline agent step makes.
type Responder interface {
	SendAgentMessage(context.Context, uuid.UUID, openfang.MessageRequest) (openfang.AgentReply, error)
}

// AgentRef names a workspace agent and its runtime identity.
type AgentRef struct {
	ID         uuid.UUID
	UpstreamID uuid.UUID
	Name       string
}

// AgentDirectory resolves the agents a step names.
type AgentDirectory interface {
	Agent(context.Context, uuid.UUID, uuid.UUID) (AgentRef, error)
	FindByCapabilities(context.Context, uuid.UUID, []string) (AgentRef, error)
}

// BoardDirectory resolves where a created issue goes.
type BoardDirectory interface {
	DefaultBoard(context.Context, uuid.UUID) (uuid.UUID, error)
	BoardWorkspace(context.Context, uuid.UUID) (uuid.UUID, error)
}

// Options are every external dependency, explicitly. Store, Clock and NewID
// are required; a step whose dependency is absent fails with a stable code
// rather than the runner refusing to start.
type Options struct {
	Store       Store
	Issues      Issues
	Approvals   Approvals
	Goals       Goals
	IssueRuns   IssueRuns
	Artifacts   Artifacts
	Responder   Responder
	Agents      AgentDirectory
	Boards      BoardDirectory
	Registry    *integrationcore.Registry
	Authorizer  integrationcore.Authorizer
	Broadcaster realtime.Broadcaster
	Clock       func() time.Time
	NewID       func() uuid.UUID
	Logger      *slog.Logger
	Metrics     *observability.AutomationMetrics
	// InlineAgentTimeout bounds one inline agent turn. Zero selects ten
	// minutes.
	InlineAgentTimeout time.Duration
}

// Runner executes runs. One instance serves every run; it keeps only the set
// of runs it is executing right now so a duplicate signal in one process
// cannot walk the same run twice.
type Runner struct {
	options  Options
	mu       sync.Mutex
	inflight map[uuid.UUID]struct{}
	subruns  SubrunStarter
}

// SetSubrunStarter names what starts the child runs subworkflow steps
// create. Called once at boot, after the starter that wraps this runner
// exists; a runner without one fails subworkflow steps with
// EXECUTOR_UNAVAILABLE rather than leaving a child pending forever.
func (runner *Runner) SetSubrunStarter(starter SubrunStarter) {
	if runner == nil {
		return
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.subruns = starter
}

func (runner *Runner) subrunStarter() SubrunStarter {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.subruns
}

// New validates the required dependencies.
func New(options Options) (*Runner, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("automation runner store is nil")
	case options.Clock == nil:
		return nil, errors.New("automation runner clock is nil")
	case options.NewID == nil:
		return nil, errors.New("automation runner ID generator is nil")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.InlineAgentTimeout <= 0 {
		options.InlineAgentTimeout = defaultInlineTimeout
	}
	return &Runner{options: options, inflight: map[uuid.UUID]struct{}{}}, nil
}

// Execute drives one run as far as it can go: a pending run starts, a
// running run continues from its rows, and anything else is left alone. It
// returns when the run finishes, waits, or the context ends.
func (runner *Runner) Execute(ctx context.Context, runID uuid.UUID) {
	if runner == nil || ctx == nil || runID == uuid.Nil {
		return
	}
	if !runner.acquire(runID) {
		return
	}
	defer runner.release(runID)
	run, err := runner.options.Store.GetRun(ctx, runID)
	if err != nil {
		runner.options.Logger.Warn("automation run not loaded", "runId", runID, "error", err)
		return
	}
	switch run.Status {
	case automationrepo.RunPending:
		started, event, err := runner.options.Store.MarkRunning(ctx, runID, runner.now(), runner.options.NewID)
		if err != nil {
			runner.options.Logger.Warn("automation run not started", "runId", runID, "error", err)
			return
		}
		runner.publish(ctx, event)
		run = started
	case automationrepo.RunRunning:
	default:
		return
	}
	runner.walk(ctx, run)
}

// Resume applies a signal to the step the run waits on and continues the
// walk. It is the entry point a Temporal activity calls; the in-process
// starter applies the signal synchronously and queues the walk.
func (runner *Runner) Resume(ctx context.Context, runID uuid.UUID, signal ResumeSignal) {
	if err := runner.ApplySignal(ctx, runID, signal); err != nil {
		runner.options.Logger.Warn("automation signal not applied", "runId", runID, "signal", signal.Key(), "error", err)
		return
	}
	runner.Execute(ctx, runID)
}

// Fail ends a run its executor lost: the orchestration's step activity
// timed out or its worker died between steps. The row's own refusals stand
// (a finished run returns ErrRunTerminal), so a failure the runner already
// recorded is never overwritten.
func (runner *Runner) Fail(ctx context.Context, runID uuid.UUID, failure automationrepo.Failure) error {
	if runner == nil || ctx == nil || runID == uuid.Nil {
		return errors.New("automation failure parameters are invalid")
	}
	if !runner.acquire(runID) {
		return ErrRunBusy
	}
	defer runner.release(runID)
	failed, event, err := runner.options.Store.Fail(ctx, runID, failure, runner.now(), runner.options.NewID)
	if err != nil {
		return err
	}
	runner.publish(ctx, event)
	runner.options.Metrics.CountRun(string(failed.Status))
	return nil
}

// ApplySignal settles the step a run waits on and returns the run to
// running. It is durable on its own: a process that dies between this and
// the walk leaves rows a later Execute continues from.
func (runner *Runner) ApplySignal(ctx context.Context, runID uuid.UUID, signal ResumeSignal) error {
	if runner == nil || ctx == nil || runID == uuid.Nil {
		return errors.New("automation signal parameters are invalid")
	}
	if !runner.acquire(runID) {
		return ErrRunBusy
	}
	defer runner.release(runID)
	run, steps, err := runner.options.Store.GetRunWithSteps(ctx, runID)
	if err != nil {
		return err
	}
	waiting := waitingStep(steps)
	switch run.Status {
	case automationrepo.RunWaiting:
		if run.WaitingOn == nil || *run.WaitingOn != signal.Key() {
			return ErrSignalMismatch
		}
		resumed, event, err := runner.options.Store.Resume(ctx, runID, runner.now(), runner.options.NewID)
		if err != nil {
			return err
		}
		runner.publish(ctx, event)
		run = resumed
	case automationrepo.RunRunning:
		// A timer claim already returned the run to running; the step is
		// what still waits.
		if signal.Kind != SignalTimer {
			return ErrSignalMismatch
		}
	default:
		return automationrepo.ErrRunTerminal
	}
	if waiting == nil {
		return errors.New("automation run has no waiting step")
	}
	definition, item, err := runner.load(ctx, run)
	if err != nil {
		runner.failRun(ctx, run, automationrepo.Failure{Code: "DEFINITION_INVALID", Message: bounded(err.Error())})
		return nil
	}
	step, ok := findStepRun(definition, waiting.StepID)
	if !ok {
		runner.failRun(ctx, run, automationrepo.Failure{Code: "DEFINITION_INVALID", Message: "The waiting step is not in the workflow version."})
		return nil
	}
	runner.settle(ctx, run, item, definition, step, *waiting, steps, signal)
	return nil
}

// settle turns a signal into the waiting step's outcome.
func (runner *Runner) settle(
	ctx context.Context,
	run automationrepo.Run,
	item automationrepo.Automation,
	definition automation.Definition,
	step automation.Step,
	row automationrepo.StepRun,
	steps []automationrepo.StepRun,
	signal ResumeSignal,
) {
	graph := buildGraph(definition)
	var (
		outcome automation.StepOutcome
		err     error
	)
	switch signal.Kind {
	case SignalApproval:
		switch signal.Outcome {
		case "approved":
			if step.Type == automation.StepAction {
				// The decision was the gate in front of the call; the call
				// itself happens now, under the approval.
				approvalID := signal.ID
				scope := runner.scope(ctx, run, definition, latestByStep(steps), row.StepID)
				outcome, err = runner.executeStep(ctx, stepCall{
					run: run, automation: item, step: step, row: row, scope: scope,
					approved: true, approvalID: &approvalID,
				})
			} else {
				outcome = succeeded(map[string]any{"approvalId": signal.ID, "decision": "approved", "detail": rawObject(signal.Payload)})
			}
		case "rejected":
			err = stepFailure("APPROVAL_REJECTED", "The approval was rejected.")
		case "expired":
			err = stepFailure("APPROVAL_EXPIRED", "The approval expired before anyone decided.")
		default:
			err = stepFailure("APPROVAL_INVALID", "The approval outcome is unknown.")
		}
	case SignalRun:
		if step.Type == automation.StepSubworkflow {
			outcome, err = runner.subworkflowOutcome(ctx, signal)
			break
		}
		switch signal.Outcome {
		case "completed":
			outcome, err = runner.runOutcome(ctx, signal.ID)
		case "failed":
			err = stepFailure("AGENT_RUN_FAILED", "The agent run failed"+runner.runFailureSuffix(ctx, signal)+".")
		case "cancelled":
			err = stepFailure("AGENT_RUN_CANCELLED", "The agent run was cancelled.")
		default:
			err = stepFailure("AGENT_RUN_FAILED", "The agent run ended with an unknown outcome.")
		}
	case SignalIssue:
		switch signal.Outcome {
		case "completed":
			outcome = succeeded(map[string]any{"issueId": signal.ID, "status": "done", "detail": rawObject(signal.Payload)})
		case "deleted":
			err = stepFailure("ISSUE_DELETED", "The issue was deleted before it completed.")
		default:
			err = stepFailure("ISSUE_DELETED", "The issue ended with an unknown outcome.")
		}
	case SignalEvent:
		outcome = succeeded(map[string]any{"topic": signal.Topic, "eventId": signal.ID, "event": rawObject(signal.Payload)})
	case SignalTimer:
		outcome = succeeded(map[string]any{"resumedAt": runner.now().Format(time.RFC3339Nano)})
	default:
		err = stepFailure("SIGNAL_INVALID", "The resume signal is unknown.")
	}
	if err == nil && outcome.Status == automation.StepWaiting {
		// A re-executed action parked again (an agent run after its
		// approval): the same row waits on the new key.
		links := links(outcome)
		if _, event, err := runner.options.Store.WaitStep(ctx, row.ID, outcome.WaitingOn, links, runner.now(), runner.options.NewID); err != nil {
			runner.options.Logger.Warn("automation step not re-parked", "runId", run.ID, "stepId", row.StepID, "error", err)
			return
		} else {
			runner.publish(ctx, event)
		}
		if _, event, err := runner.options.Store.MarkWaiting(ctx, run.ID, row.StepID, outcome.WaitingOn, outcome.ResumeAt, runner.now(), runner.options.NewID); err == nil {
			runner.publish(ctx, event)
		}
		return
	}
	runner.record(ctx, run, graph, step, row, outcome, err)
}

// walk executes eligible steps in definition order until the run finishes,
// waits, or the process stops.
func (runner *Runner) walk(ctx context.Context, run automationrepo.Run) {
	definition, item, err := runner.load(ctx, run)
	if err != nil {
		runner.failRun(ctx, run, automationrepo.Failure{Code: "DEFINITION_INVALID", Message: bounded(err.Error())})
		return
	}
	static := buildGraph(definition)
	for {
		if ctx.Err() != nil {
			return
		}
		current, steps, err := runner.options.Store.GetRunWithSteps(ctx, run.ID)
		if err != nil {
			runner.options.Logger.Warn("automation run not reloaded", "runId", run.ID, "error", err)
			return
		}
		if current.Status != automationrepo.RunRunning {
			return
		}
		state := latestByStep(steps)
		if waitingStep(steps) != nil {
			// Something still waits; the signal that settles it continues.
			return
		}
		graph := static.expand(state)
		next, decision := graph.next(state)
		switch decision {
		case decisionPrune:
			runner.prune(ctx, current, definition, graph.closure([]string{next}, state))
			continue
		case decisionDone:
			finished, event, err := runner.options.Store.CompleteSuccess(ctx, run.ID, runner.now(), runner.options.NewID)
			if err != nil {
				runner.options.Logger.Warn("automation run not completed", "runId", run.ID, "error", err)
				return
			}
			runner.publish(ctx, event)
			runner.options.Metrics.CountRun(string(finished.Status))
			return
		case decisionStuck:
			runner.failRun(ctx, current, automationrepo.Failure{Code: "WORKFLOW_STUCK", Message: "No step can run and the workflow has not finished."})
			return
		}
		step, _ := findStepRun(definition, next)
		input, _ := json.Marshal(step)
		row, event, err := runner.options.Store.StartStep(ctx, automationrepo.StartStepParams{
			ID: runner.options.NewID(), RunID: run.ID, StepID: next, StepType: step.Type,
			Attempt: nextAttempt(state, next), Input: input, Now: runner.now(), NewID: runner.options.NewID,
		})
		if err != nil {
			// A conflict on the attempt key means another worker holds the
			// step; a terminal run means someone cancelled it. Neither is
			// ours to continue.
			runner.options.Logger.Info("automation step not started", "runId", run.ID, "stepId", next, "error", err)
			return
		}
		runner.publish(ctx, event)
		scope := runner.scope(ctx, current, definition, state, next)
		outcome, execErr := runner.executeStep(ctx, stepCall{run: current, automation: item, step: step, row: row, scope: scope})
		if !runner.record(ctx, current, graph, step, row, outcome, execErr) {
			return
		}
	}
}

// record persists a step's outcome and reports whether the walk goes on.
func (runner *Runner) record(
	ctx context.Context,
	run automationrepo.Run,
	graph graph,
	step automation.Step,
	row automationrepo.StepRun,
	outcome automation.StepOutcome,
	execErr error,
) bool {
	store, now, newID := runner.options.Store, runner.now, runner.options.NewID
	if execErr != nil {
		failure, usage := toFailure(execErr)
		if usage != nil {
			// A paid call that failed still cost tokens; the run's sum keeps
			// them even though the step has no output.
			if err := store.AddUsage(ctx, run.ID, *usage, now()); err != nil {
				runner.options.Logger.Warn("automation usage not recorded", "runId", run.ID, "error", err)
			}
		}
		_, event, err := store.FailStep(ctx, row.ID, failure, now(), newID)
		if err != nil {
			runner.options.Logger.Warn("automation step not failed", "runId", run.ID, "stepId", row.StepID, "error", err)
			return false
		}
		runner.publish(ctx, event)
		if step.OnError == automation.OnErrorSkip {
			runner.options.Logger.Info("automation step failed and was skipped by policy",
				"runId", run.ID, "stepId", row.StepID, "code", failure.Code)
			return true
		}
		runner.failRun(ctx, run, failure)
		return false
	}
	switch outcome.Status {
	case automation.StepWaiting:
		if _, event, err := store.WaitStep(ctx, row.ID, outcome.WaitingOn, links(outcome), now(), newID); err != nil {
			runner.options.Logger.Warn("automation step not parked", "runId", run.ID, "stepId", row.StepID, "error", err)
			return false
		} else {
			runner.publish(ctx, event)
		}
		if _, event, err := store.MarkWaiting(ctx, run.ID, row.StepID, outcome.WaitingOn, outcome.ResumeAt, now(), newID); err != nil {
			runner.options.Logger.Warn("automation run not parked", "runId", run.ID, "stepId", row.StepID, "error", err)
		} else {
			runner.publish(ctx, event)
		}
		return false
	case automation.StepSkipped:
		_, event, err := store.FailStep(ctx, row.ID, automationrepo.Failure{Code: "STEP_SKIPPED", Message: "The step chose not to run."}, now(), newID)
		if err != nil {
			return false
		}
		runner.publish(ctx, event)
		return true
	default:
		output := outcome.Output
		if len(output) == 0 {
			output = json.RawMessage(`{}`)
		}
		_, event, err := store.CompleteStep(ctx, row.ID, output, outcome.Usage, links(outcome), now(), newID)
		if err != nil {
			runner.options.Logger.Warn("automation step not completed", "runId", run.ID, "stepId", row.StepID, "error", err)
			return false
		}
		runner.publish(ctx, event)
		if (step.Type == automation.StepCondition && step.Condition != nil) || (step.Type == automation.StepSwitch && step.Switch != nil) {
			taken := map[string]bool{}
			for _, id := range outcome.Next {
				taken[id] = true
			}
			var untaken []string
			for _, id := range step.Children() {
				if !taken[id] {
					untaken = append(untaken, id)
				}
			}
			if len(untaken) > 0 {
				runner.prune(ctx, run, graph.definition, graph.closure(untaken, nil))
			}
		}
		return true
	}
}

// prune records the steps of a branch the run did not take as skipped.
func (runner *Runner) prune(ctx context.Context, run automationrepo.Run, definition automation.Definition, ids []string) {
	for _, id := range ids {
		step, ok := findStepRun(definition, id)
		if !ok {
			continue
		}
		_, event, err := runner.options.Store.RecordSkippedStep(ctx, automationrepo.StartStepParams{
			ID: runner.options.NewID(), RunID: run.ID, StepID: id, StepType: step.Type, Attempt: 1,
			Now: runner.now(), NewID: runner.options.NewID,
		})
		if err != nil {
			if !errors.Is(err, automationrepo.ErrConflict) {
				runner.options.Logger.Warn("automation branch not pruned", "runId", run.ID, "stepId", id, "error", err)
			}
			continue
		}
		runner.publish(ctx, event)
	}
}

func (runner *Runner) failRun(ctx context.Context, run automationrepo.Run, failure automationrepo.Failure) {
	failed, event, err := runner.options.Store.Fail(ctx, run.ID, failure, runner.now(), runner.options.NewID)
	if err != nil {
		runner.options.Logger.Warn("automation run not failed", "runId", run.ID, "code", failure.Code, "error", err)
		return
	}
	runner.publish(ctx, event)
	runner.options.Metrics.CountRun(string(failed.Status))
}

// load reads the definition version the run was created against.
func (runner *Runner) load(ctx context.Context, run automationrepo.Run) (automation.Definition, automationrepo.Automation, error) {
	item, err := runner.options.Store.Get(ctx, run.AutomationID)
	if err != nil {
		return automation.Definition{}, automationrepo.Automation{}, err
	}
	version, err := runner.options.Store.GetVersion(ctx, run.AutomationID, run.AutomationVersion)
	if err != nil {
		return automation.Definition{}, automationrepo.Automation{}, err
	}
	definition, findings := automation.ParseDefinition(version.Definition)
	if len(findings) > 0 {
		return automation.Definition{}, automationrepo.Automation{}, errors.New("stored workflow definition does not parse: " + findings[0].Message)
	}
	return definition, item, nil
}

func (runner *Runner) acquire(runID uuid.UUID) bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if _, busy := runner.inflight[runID]; busy {
		return false
	}
	runner.inflight[runID] = struct{}{}
	return true
}

func (runner *Runner) release(runID uuid.UUID) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	delete(runner.inflight, runID)
}

func (runner *Runner) now() time.Time {
	return runner.options.Clock().UTC()
}

func findStep(definition automation.Definition, id string) (automation.Step, bool) {
	for _, step := range definition.Steps {
		if step.ID == id {
			return step, true
		}
	}
	return automation.Step{}, false
}

// findStepRun resolves a stored step id, with or without a foreach index,
// to the definition's step.
func findStepRun(definition automation.Definition, stepRunID string) (automation.Step, bool) {
	base, _, _ := automation.SplitStepRunID(stepRunID)
	return findStep(definition, base)
}

// latestByStep keeps the highest attempt of every step.
func latestByStep(steps []automationrepo.StepRun) map[string]automationrepo.StepRun {
	state := make(map[string]automationrepo.StepRun, len(steps))
	for _, step := range steps {
		if current, ok := state[step.StepID]; !ok || step.Attempt > current.Attempt {
			state[step.StepID] = step
		}
	}
	return state
}

func waitingStep(steps []automationrepo.StepRun) *automationrepo.StepRun {
	for _, step := range latestByStep(steps) {
		if step.Status == automationrepo.StepWaiting {
			waiting := step
			return &waiting
		}
	}
	return nil
}

func nextAttempt(state map[string]automationrepo.StepRun, stepID string) int {
	if current, ok := state[stepID]; ok {
		return current.Attempt + 1
	}
	return 1
}

func links(outcome automation.StepOutcome) automationrepo.StepLinks {
	return automationrepo.StepLinks{
		IssueRunID:   outcome.Links.IssueRunID,
		IssueID:      outcome.Links.IssueID,
		ApprovalID:   outcome.Links.ApprovalID,
		AuditEventID: outcome.Links.AuditEventID,
	}
}

// runFailureSuffix names the run's own failure code (RUN_INCOMPLETE,
// STREAM_INTERRUPTED, ...) so the step says why the agent run failed. The
// run row is authoritative; the fact's payload is the fallback.
func (runner *Runner) runFailureSuffix(ctx context.Context, signal ResumeSignal) string {
	if runner.options.IssueRuns != nil && signal.ID != uuid.Nil {
		if run, err := runner.options.IssueRuns.Get(ctx, signal.ID); err == nil && run.Failure != nil && run.Failure.Code != "" {
			return " (" + run.Failure.Code + ")"
		}
	}
	return payloadFailureSuffix(signal.Payload)
}

func payloadFailureSuffix(payload json.RawMessage) string {
	var envelope struct {
		Run struct {
			Failure *struct {
				Code string `json:"code"`
			} `json:"failure"`
		} `json:"run"`
	}
	if json.Unmarshal(payload, &envelope) == nil && envelope.Run.Failure != nil && envelope.Run.Failure.Code != "" {
		return " (" + envelope.Run.Failure.Code + ")"
	}
	return ""
}
