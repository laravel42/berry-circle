package automation

import (
	"context"
	"errors"
	"testing"
)

// An absent engine refuses every operation with one error so a workflow that
// needs it can never be half-activated.
func TestNoopEngineFailsClosed(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	var engine Engine = NoopEngine{}
	checks := map[string]error{}
	_, checks["EnsureFlow"] = engine.EnsureFlow(ctx, FlowSpec{})
	checks["SetFlowStatus"] = engine.SetFlowStatus(ctx, "flow", true)
	checks["DeleteFlow"] = engine.DeleteFlow(ctx, "flow")
	_, checks["StartRun"] = engine.StartRun(ctx, "flow", nil, "key")
	_, checks["GetRun"] = engine.GetRun(ctx, "run")
	_, checks["ListPieces"] = engine.ListPieces(ctx)
	checks["RegisterWebhook"] = engine.RegisterWebhook(ctx, "flow", "https://berry.test/hook")
	for name, err := range checks {
		if !errors.Is(err, ErrEngineDisabled) {
			t.Errorf("%s = %v, want ErrEngineDisabled", name, err)
		}
	}
}
