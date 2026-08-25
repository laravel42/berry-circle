package orchestration

import "testing"

// TestDispatchIsNeverRetried guards the single most dangerous regression in
// this package.
//
// POST /api/agents/{id}/message/stream is classified RetryUnsafe upstream and
// is attempted exactly once (internal/openfang/transport.go). Temporal
// activities retry by default, so any retry policy on the dispatch activity
// would run the agent a second time — duplicating paid execution and tool side
// effects, and violating the pinned OpenFang contract (ADR-0005).
//
// If this test fails, do not adjust the expectation. Fix the policy.
func TestDispatchIsNeverRetried(t *testing.T) {
	options := dispatchActivityOptions()

	if options.RetryPolicy == nil {
		t.Fatal("dispatch activity has no retry policy: the SDK default retries forever")
	}
	if options.RetryPolicy.MaximumAttempts != 1 {
		t.Fatalf(
			"dispatch MaximumAttempts = %d, want 1: a retry re-POSTs an unsafe dispatch",
			options.RetryPolicy.MaximumAttempts,
		)
	}
	if options.HeartbeatTimeout <= 0 {
		t.Fatal("dispatch activity needs a heartbeat timeout to detect a dead worker")
	}
	if options.StartToCloseTimeout <= options.HeartbeatTimeout {
		t.Fatal("StartToCloseTimeout must exceed HeartbeatTimeout")
	}
}

// TestStreamBoundExpiresBeforeTemporalGivesUp pins the order the bounds fire
// in. The SSE client's close is recorded in the ledger as STREAM_TIMEOUT and
// the activity returns normally; an activity timed out by Temporal instead
// fails the orchestration before the promotion and delivery that follow the
// dispatch.
func TestStreamBoundExpiresBeforeTemporalGivesUp(t *testing.T) {
	options := dispatchActivityOptions()

	if options.StartToCloseTimeout <= DispatchStreamTimeout {
		t.Fatal("dispatch StartToCloseTimeout must exceed DispatchStreamTimeout so the SSE client closes first")
	}
	if RunOrchestrationTimeout <= options.StartToCloseTimeout {
		t.Fatal("RunOrchestrationTimeout must leave room for the activities after the dispatch")
	}
}

// TestLedgerActivitiesRetry confirms the safe operations do retry: they are
// idempotent ledger writes and the durable cancellation claim, where giving up
// after one transient database error would strand a run.
func TestLedgerActivitiesRetry(t *testing.T) {
	options := ledgerActivityOptions()

	if options.RetryPolicy == nil || options.RetryPolicy.MaximumAttempts < 2 {
		t.Fatal("safe ledger activities should retry on transient failure")
	}
}
