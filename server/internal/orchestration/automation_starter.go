package orchestration

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"

	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// AutomationClient is what the starter needs from a Temporal client. The
// real client satisfies it; tests run the same starter over the test suite
// so the starter's contract is exercised without a server.
type AutomationClient interface {
	ExecuteWorkflow(ctx context.Context, options client.StartWorkflowOptions, workflow interface{}, args ...interface{}) (client.WorkflowRun, error)
	SignalWorkflow(ctx context.Context, workflowID, runID, signalName string, arg interface{}) error
	SignalWithStartWorkflow(ctx context.Context, workflowID, signalName string, signalArg interface{}, options client.StartWorkflowOptions, workflow interface{}, workflowArgs ...interface{}) (client.WorkflowRun, error)
}

// AutomationStarter hands workflow runs to Temporal instead of the
// in-process pool, so a run — and above all a run parked on a person —
// survives the API process that created it. It satisfies
// automationrun.Starter and automationrun.Canceller.
type AutomationStarter struct {
	client    AutomationClient
	taskQueue string
}

// NewAutomationStarter validates its dependencies at construction so a
// misconfigured deployment fails at boot rather than on the first run.
func NewAutomationStarter(temporal AutomationClient, taskQueue string) (*AutomationStarter, error) {
	if temporal == nil {
		return nil, errors.New("temporal client is nil")
	}
	if taskQueue == "" {
		return nil, errors.New("temporal task queue is required")
	}
	return &AutomationStarter{client: temporal, taskQueue: taskQueue}, nil
}

// Start begins the run's orchestration.
//
// The workflow id is derived from the run id and a duplicate start is
// success: the run row is created idempotently on its source event, so a
// second dispatcher tick or a retried route must not produce a second
// orchestration for one row, and reporting an error there would make a
// harmless retry look like a failure.
func (starter *AutomationStarter) Start(ctx context.Context, runID uuid.UUID) error {
	if starter == nil {
		return errors.New("automation starter is not configured")
	}
	if runID == uuid.Nil {
		return errors.New("run id is required")
	}
	options := starter.options(runID)
	options.WorkflowIDConflictPolicy = enums.WORKFLOW_ID_CONFLICT_POLICY_FAIL
	_, err := starter.client.ExecuteWorkflow(ctx, options, AutomationOrchestrationName, runID.String())
	if err != nil {
		if alreadyStarted(err) {
			return nil
		}
		return fmt.Errorf("start automation orchestration: %w", err)
	}
	return nil
}

// Resume delivers the fact a parked run waited on. It signals with start
// rather than signals: a run that parked before its orchestration existed
// — executed in-process before Temporal was enabled, or whose
// orchestration reached its run timeout — gets one now, which reads the
// rows, applies the signal and carries on. Nothing is applied here: the
// worker applies the signal so the resumed step, itself possibly a paid
// call, executes where every other step does.
func (starter *AutomationStarter) Resume(ctx context.Context, runID uuid.UUID, signal automationrun.ResumeSignal) error {
	if starter == nil {
		return errors.New("automation starter is not configured")
	}
	if runID == uuid.Nil {
		return errors.New("run id is required")
	}
	if signal.Key() == "" {
		return errors.New("resume signal is invalid")
	}
	_, err := starter.client.SignalWithStartWorkflow(
		ctx,
		AutomationRunWorkflowID(runID),
		AutomationResumeSignal,
		ResumePayload(signal),
		starter.options(runID),
		AutomationOrchestrationName,
		runID.String(),
	)
	if err != nil {
		return fmt.Errorf("resume automation orchestration: %w", err)
	}
	return nil
}

// Cancel tells a waiting orchestration to stop waiting. The row is already
// cancelled by the caller; an orchestration that no longer exists has
// nothing left to stop, so that is success too.
func (starter *AutomationStarter) Cancel(ctx context.Context, runID uuid.UUID) error {
	if starter == nil {
		return errors.New("automation starter is not configured")
	}
	if runID == uuid.Nil {
		return errors.New("run id is required")
	}
	err := starter.client.SignalWorkflow(ctx, AutomationRunWorkflowID(runID), "", AutomationCancelSignal, AutomationCancel{})
	if err != nil {
		var notFound *serviceerror.NotFound
		if errors.As(err, &notFound) {
			return nil
		}
		return fmt.Errorf("cancel automation orchestration: %w", err)
	}
	return nil
}

func (starter *AutomationStarter) options(runID uuid.UUID) client.StartWorkflowOptions {
	return client.StartWorkflowOptions{
		ID:                    AutomationRunWorkflowID(runID),
		TaskQueue:             starter.taskQueue,
		WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		WorkflowRunTimeout:    AutomationRunTimeout,
	}
}

func alreadyStarted(err error) bool {
	var started *serviceerror.WorkflowExecutionAlreadyStarted
	return errors.As(err, &started)
}
