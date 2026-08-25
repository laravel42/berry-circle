package orchestration

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"

	"go.temporal.io/api/enums/v1"
)

// TemporalDispatcher hands admitted runs to Temporal instead of an in-process
// channel, so a run survives the API process that accepted it.
type TemporalDispatcher struct {
	client    client.Client
	taskQueue string
}

// NewTemporalDispatcher validates its dependencies at construction so a
// misconfigured deployment fails at boot rather than on the first dispatch.
func NewTemporalDispatcher(temporal client.Client, taskQueue string) (*TemporalDispatcher, error) {
	if temporal == nil {
		return nil, errors.New("temporal client is nil")
	}
	if taskQueue == "" {
		return nil, errors.New("temporal task queue is required")
	}
	return &TemporalDispatcher{client: temporal, taskQueue: taskQueue}, nil
}

// Dispatch starts the run's orchestration.
//
// The workflow id is derived from the run id, and a duplicate start is treated
// as success. Admission already guarantees at most one active run per issue, so
// a retried request must not produce a second orchestration for one ledger row
// — and reporting an error there would make a harmless retry look like a
// failure to the caller.
func (dispatcher *TemporalDispatcher) Dispatch(ctx context.Context, runID uuid.UUID) error {
	if runID == uuid.Nil {
		return errors.New("run id is required")
	}
	_, err := dispatcher.client.ExecuteWorkflow(
		ctx,
		client.StartWorkflowOptions{
			ID:        RunWorkflowID(runID.String()),
			TaskQueue: dispatcher.taskQueue,
			// Rejecting a duplicate is the guarantee; the error it produces is
			// then interpreted as "already dispatched" below.
			WorkflowIDReusePolicy:    enums.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
			WorkflowIDConflictPolicy: enums.WORKFLOW_ID_CONFLICT_POLICY_FAIL,
			WorkflowRunTimeout:       RunOrchestrationTimeout,
		},
		RunOrchestrationName,
		runID.String(),
	)
	if err != nil {
		var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
		if errors.As(err, &alreadyStarted) {
			return nil
		}
		return fmt.Errorf("start run orchestration: %w", err)
	}
	return nil
}
