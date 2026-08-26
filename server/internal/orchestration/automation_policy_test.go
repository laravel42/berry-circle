package orchestration

import "testing"

// TestAutomationStepsAreNeverRetried mirrors TestDispatchIsNeverRetried for
// workflow runs.
//
// A step activity walks the run through provider actions, model turns and
// agent admissions — each a paid, unsafe call the runner records exactly
// once. Temporal activities retry by default, so any retry policy here would
// repeat those calls after a transient failure that the ledger has already
// recorded as final.
//
// If this test fails, do not adjust the expectation. Fix the policy.
func TestAutomationStepsAreNeverRetried(t *testing.T) {
	options := automationActivityOptions()

	if options.RetryPolicy == nil {
		t.Fatal("automation step activity has no retry policy: the SDK default retries forever")
	}
	if options.RetryPolicy.MaximumAttempts != 1 {
		t.Fatalf(
			"automation step MaximumAttempts = %d, want 1: a retry repeats a paid step",
			options.RetryPolicy.MaximumAttempts,
		)
	}
	if options.HeartbeatTimeout <= 0 {
		t.Fatal("automation step activity needs a heartbeat timeout to detect a dead worker")
	}
	if options.StartToCloseTimeout <= options.HeartbeatTimeout {
		t.Fatal("StartToCloseTimeout must exceed HeartbeatTimeout")
	}
}

// TestAutomationRunOutlastsItsSteps pins that a run may stay parked on a
// person far longer than one step activity may execute.
func TestAutomationRunOutlastsItsSteps(t *testing.T) {
	if AutomationRunTimeout <= AutomationActivityTimeout {
		t.Fatal("AutomationRunTimeout must leave room for waits between step activities")
	}
}
