package orchestration

import (
	"time"

	"go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// intakeTicksBeforeContinue bounds one execution's history before it starts a
// fresh run via continue-as-new. A perpetual loop that never rolls its history
// grows without limit and eventually cannot replay.
const intakeTicksBeforeContinue = 500

// IntakeOrchestration is the continuous loop that hands ready work to
// available agents.
//
// Each tick durably admits runs for issues in `todo` whose assigned agent is
// available, then starts one RunOrchestration per admitted run. The loop runs
// forever, rolling itself with continue-as-new so history stays bounded.
//
// Why a loop rather than a Temporal Schedule: the interval is short and the
// tick is cheap, and a single long-lived execution gives one place to query
// intake liveness. A Schedule would work equally well and is the better choice
// if intake ever needs per-tick visibility in the UI.
//
// Children are started with ABANDON. A run must outlive the intake tick that
// created it — and must survive intake being disabled or rolled — because the
// run holds a real agent execution and a real ledger row. Tying its lifetime
// to the scheduler would let an operator kill live agent work by turning
// intake off.
func IntakeOrchestration(ctx workflow.Context, params IntakeParams) error {
	logger := workflow.GetLogger(ctx)
	if params.BatchSize < 1 {
		params.BatchSize = 10
	}
	if params.MaxConcurrent < 1 {
		params.MaxConcurrent = 8
	}
	if params.Interval <= 0 {
		params.Interval = defaultIntakeInterval
	}

	for tick := 0; tick < intakeTicksBeforeContinue; tick++ {
		activityCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: IntakeActivityTimeout,
			HeartbeatTimeout:    30 * time.Second,
			RetryPolicy: &temporal.RetryPolicy{
				InitialInterval:    time.Second,
				BackoffCoefficient: 2,
				MaximumInterval:    30 * time.Second,
				MaximumAttempts:    3,
			},
		})

		var result IntakeResult
		err := workflow.ExecuteActivity(
			activityCtx,
			(*Activities).ClaimIntakeBatch,
			params,
		).Get(ctx, &result)
		if err != nil {
			// A failing tick must not kill the loop: the database may be
			// briefly unavailable, and intake should resume on its own.
			logger.Error("intake tick failed", "error", err)
		} else if result.Admitted > 0 {
			logger.Info(
				"intake admitted runs",
				"admitted", result.Admitted,
				"routed", result.Routed,
				"fallback", result.Fallback,
				"skipped", result.Skipped,
				"considered", result.Considered,
			)
			startRuns(ctx, result.RunIDs)
		}

		if err := workflow.Sleep(ctx, params.Interval); err != nil {
			return err
		}
	}

	return workflow.NewContinueAsNewError(ctx, IntakeOrchestration, params)
}

// startRuns launches one abandoned child per admitted run.
//
// Only the child *start* is awaited, not its result. Waiting for completion
// would serialise the intake loop behind the slowest agent, and the runs are
// independent by construction — the one-writer-per-issue guard already
// guarantees no two of them touch the same issue.
func startRuns(ctx workflow.Context, runIDs []string) {
	logger := workflow.GetLogger(ctx)
	futures := make([]workflow.ChildWorkflowFuture, 0, len(runIDs))

	for _, runID := range runIDs {
		childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
			WorkflowID:        RunWorkflowID(runID),
			ParentClosePolicy: enums.PARENT_CLOSE_POLICY_ABANDON,
			// Admission already guarantees one active run per issue. Rejecting
			// a duplicate start makes that true at the Temporal layer too, so a
			// replayed tick cannot produce two orchestrations for one ledger row.
			WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
			WorkflowRunTimeout:    RunOrchestrationTimeout,
		})
		futures = append(
			futures,
			workflow.ExecuteChildWorkflow(childCtx, RunOrchestration, runID),
		)
	}

	for index, future := range futures {
		if err := future.GetChildWorkflowExecution().Get(ctx, nil); err != nil {
			logger.Warn("child run did not start", "runId", runIDs[index], "error", err)
		}
	}
}

const defaultIntakeInterval = 10 * time.Second
