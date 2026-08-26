package orchestration

import (
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// automationActivityOptions pins the at-most-once contract for the
// activities that execute workflow steps.
//
// MaximumAttempts is 1 and must stay 1. A step is a provider action, a model
// turn or an admitted agent run — a paid, unsafe call — and the runner records
// every outcome on the ledger before it returns, so a retry would repeat the
// call rather than recover from anything. automation_policy_test.go guards
// it the way dispatch_policy_test.go guards the run dispatch.
func automationActivityOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: AutomationActivityTimeout,
		HeartbeatTimeout:    AutomationHeartbeat,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 1,
		},
	}
}

// AutomationOrchestration drives one workflow run to a terminal ledger state.
//
// It is as thin as RunOrchestration. The runner owns every step, every ledger
// write and every wait key, and the in-process starter drives the same runner,
// so the two paths cannot interpret a definition differently. What the
// orchestration adds is durability of the waits: a run parked on an approval
// survives the process that parked it, and the resume signal reaches it on
// whichever worker is alive.
//
// The run row is durable before this starts — the trigger dispatcher or a
// route created it — and every wait is recorded on the row, so the
// orchestration never creates product state and can be rebuilt from the rows.
func AutomationOrchestration(ctx workflow.Context, runID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("automation orchestration started", "runId", runID)

	// Registered before the first activity so a signal that arrives while
	// the run is still walking is buffered rather than lost.
	resumeChannel := workflow.GetSignalChannel(ctx, AutomationResumeSignal)
	cancelChannel := workflow.GetSignalChannel(ctx, AutomationCancelSignal)
	stepCtx := workflow.WithActivityOptions(ctx, automationActivityOptions())

	var state AutomationRunState
	if err := workflow.ExecuteActivity(
		stepCtx,
		(*Activities).ExecuteAutomationRun,
		runID,
	).Get(stepCtx, &state); err != nil {
		return abandonAutomationRun(ctx, runID, err)
	}

	for !state.Terminal {
		var (
			resume    AutomationResume
			cancel    AutomationCancel
			cancelled bool
		)
		selector := workflow.NewSelector(ctx)
		// Cancellation first: when both are buffered, the person who cancelled
		// the run wins over the fact that would have resumed it.
		selector.AddReceive(cancelChannel, func(channel workflow.ReceiveChannel, _ bool) {
			channel.Receive(ctx, &cancel)
			cancelled = true
		})
		selector.AddReceive(resumeChannel, func(channel workflow.ReceiveChannel, _ bool) {
			channel.Receive(ctx, &resume)
		})
		selector.AddReceive(ctx.Done(), func(workflow.ReceiveChannel, bool) {
			cancelled = true
		})
		selector.Select(ctx)
		if ctx.Err() != nil {
			logger.Info("automation orchestration cancelled by Temporal", "runId", runID)
			return ctx.Err()
		}
		if cancelled {
			// The row was already cancelled by the route that sent the
			// signal; the orchestration only stops waiting.
			logger.Info("automation orchestration cancelled", "runId", runID, "requestedBy", cancel.RequestedBy)
			return nil
		}
		if err := workflow.ExecuteActivity(
			stepCtx,
			(*Activities).ResumeAutomationRun,
			runID,
			resume,
		).Get(stepCtx, &state); err != nil {
			return abandonAutomationRun(ctx, runID, err)
		}
	}

	logger.Info("automation orchestration finished", "runId", runID, "status", state.Status)
	return nil
}

// abandonAutomationRun records that the orchestration could not finish the
// run — a worker died mid-walk, or a step activity exceeded its bound — so
// the row does not stay running forever. Best effort on a disconnected
// context: the runner refuses to touch a run that already finished, which is
// the common case, because it records most failures itself before the
// activity returns.
func abandonAutomationRun(ctx workflow.Context, runID string, cause error) error {
	disconnected, release := workflow.NewDisconnectedContext(ctx)
	defer release()
	failCtx := workflow.WithActivityOptions(disconnected, ledgerActivityOptions())
	if err := workflow.ExecuteActivity(
		failCtx,
		(*Activities).FailAutomationRun,
		runID,
		cause.Error(),
	).Get(failCtx, nil); err != nil {
		workflow.GetLogger(ctx).Warn("automation run not marked failed", "runId", runID, "error", err)
	}
	return cause
}
