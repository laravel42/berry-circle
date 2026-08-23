package orchestration

import (
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// dispatchActivityOptions pins the at-most-once dispatch contract.
//
// MaximumAttempts is 1 and must stay 1. See DispatchRun for why, and
// activities_test.go for the assertion that guards it.
func dispatchActivityOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: DispatchStreamTimeout,
		HeartbeatTimeout:    DispatchHeartbeat,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 1,
		},
	}
}

// ledgerActivityOptions apply to safe, idempotent ledger and cancel work.
func ledgerActivityOptions() workflow.ActivityOptions {
	return workflow.ActivityOptions{
		StartToCloseTimeout: LedgerActivityTimeout,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    30 * time.Second,
			MaximumAttempts:    5,
		},
	}
}

// RunOrchestration drives one admitted run to a terminal ledger state.
//
// It is deliberately thin. All projection logic lives in the activity, which
// shares it with the in-process dispatcher; the workflow contributes exactly
// two things the channel-based pool could not: the dispatch survives a
// process restart, and a cancellation signal reaches the run even if the API
// node that accepted it is gone.
//
// The run is already durable in PostgreSQL before this starts — admission
// commits the queued ledger row. This workflow never creates product state.
func RunOrchestration(ctx workflow.Context, runID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("run orchestration started", "runId", runID)

	// Registered before dispatch so a cancellation that arrives during the
	// stream is not lost.
	cancelChannel := workflow.GetSignalChannel(ctx, CancelRunSignal)

	dispatchCtx, stopDispatch := workflow.WithCancel(
		workflow.WithActivityOptions(ctx, dispatchActivityOptions()),
	)
	dispatch := workflow.ExecuteActivity(
		dispatchCtx,
		(*Activities).DispatchRun,
		runID,
	)

	var cancelRequest CancelRequest
	var dispatchErr error
	done := false

	for !done {
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(dispatch, func(future workflow.Future) {
			dispatchErr = future.Get(ctx, nil)
			done = true
		})
		selector.AddReceive(cancelChannel, func(channel workflow.ReceiveChannel, _ bool) {
			channel.Receive(ctx, &cancelRequest)
			logger.Info("cancellation requested", "runId", runID)

			// The activity owns the single permitted upstream stop call and the
			// durable claim that decides who makes it. Cancelling the workflow
			// context afterwards releases the streaming activity.
			cancelCtx := workflow.WithActivityOptions(ctx, ledgerActivityOptions())
			if err := workflow.ExecuteActivity(
				cancelCtx,
				(*Activities).CancelRun,
				runID,
				cancelRequest.RequestedBy,
			).Get(ctx, nil); err != nil {
				logger.Warn("cancellation did not confirm", "runId", runID, "error", err)
			}
			stopDispatch()
		})
		selector.Select(ctx)
	}

	if dispatchErr != nil {
		logger.Error("run dispatch failed", "runId", runID, "error", dispatchErr)
		return dispatchErr
	}
	logger.Info("run orchestration finished", "runId", runID)
	return nil
}
