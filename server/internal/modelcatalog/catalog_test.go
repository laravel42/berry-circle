package modelcatalog

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/openrouter"
)

type stubRuntime struct {
	models []openfang.CatalogModel
	err    error
	calls  int
}

func (stub *stubRuntime) ListModelCatalog(context.Context) ([]openfang.CatalogModel, error) {
	stub.calls++
	return stub.models, stub.err
}

type stubLister struct {
	models []openrouter.Model
	err    error
	calls  int
}

func (stub *stubLister) ListModels(context.Context) ([]openrouter.Model, error) {
	stub.calls++
	return stub.models, stub.err
}

func runtimeCatalog() *stubRuntime {
	return &stubRuntime{models: []openfang.CatalogModel{
		// Stale: this build predates the models OpenRouter now serves.
		{ID: "openrouter/anthropic/claude-sonnet-4", Provider: "openrouter", Available: true},
		{ID: "claude-sonnet-4-6", Provider: "anthropic", Available: true},
		{ID: "llama3.2", Provider: "ollama", Available: true},
	}}
}

func liveCatalog() *stubLister {
	return &stubLister{models: []openrouter.Model{
		{ID: "deepseek/deepseek-v4-flash-0731", DisplayName: "DeepSeek V4 Flash 0731",
			ContextWindow: 1310720, InputCostPerM: 0.066, OutputCostPerM: 0.132, SupportsTools: true},
	}}
}

func find(models []openfang.CatalogModel, provider, id string) (openfang.CatalogModel, bool) {
	for _, model := range models {
		if model.Provider == provider && model.ID == id {
			return model, true
		}
	}
	return openfang.CatalogModel{}, false
}

// The whole point: a model newer than the runtime build must be offered, and
// the runtime's stale OpenRouter entries must not survive alongside it.
func TestLiveCatalogReplacesTheRuntimeOpenRouterEntries(t *testing.T) {
	merged := &Merged{Runtime: runtimeCatalog(), OpenRouter: liveCatalog()}
	models, err := merged.ListModelCatalog(context.Background())
	if err != nil {
		t.Fatalf("ListModelCatalog: %v", err)
	}
	if _, ok := find(models, "openrouter", "deepseek/deepseek-v4-flash-0731"); !ok {
		t.Error("a model OpenRouter serves is missing from the merged catalog")
	}
	if _, ok := find(models, "openrouter", "openrouter/anthropic/claude-sonnet-4"); ok {
		t.Error("the runtime's stale OpenRouter entry survived the merge")
	}
	// Providers Berry does not talk to directly stay as the runtime reports them.
	for _, want := range []struct{ provider, id string }{
		{"anthropic", "claude-sonnet-4-6"},
		{"ollama", "llama3.2"},
	} {
		if _, ok := find(models, want.provider, want.id); !ok {
			t.Errorf("runtime entry %s/%s was dropped", want.provider, want.id)
		}
	}
}

func TestLiveModelsAreMappedForDisplay(t *testing.T) {
	merged := &Merged{Runtime: runtimeCatalog(), OpenRouter: liveCatalog()}
	models, _ := merged.ListModelCatalog(context.Background())
	model, ok := find(models, "openrouter", "deepseek/deepseek-v4-flash-0731")
	if !ok {
		t.Fatal("model missing")
	}
	if model.DisplayName != "DeepSeek V4 Flash 0731" {
		t.Errorf("DisplayName = %q", model.DisplayName)
	}
	if model.ContextWindow != 1310720 {
		t.Errorf("ContextWindow = %d", model.ContextWindow)
	}
	if !model.SupportsTools {
		t.Error("SupportsTools was dropped; agents cannot run without tool calling")
	}
	if !model.Available {
		t.Error("a model OpenRouter serves must be available")
	}
}

// A transient OpenRouter outage must not empty the picker.
func TestRuntimeCatalogServesWhenOpenRouterIsUnreachable(t *testing.T) {
	merged := &Merged{
		Runtime:    runtimeCatalog(),
		OpenRouter: &stubLister{err: errors.New("network is down")},
	}
	models, err := merged.ListModelCatalog(context.Background())
	if err != nil {
		t.Fatalf("ListModelCatalog: %v", err)
	}
	if _, ok := find(models, "openrouter", "openrouter/anthropic/claude-sonnet-4"); !ok {
		t.Error("fell back to nothing; the runtime's entries should still serve")
	}
}

// Once fetched, a later failure serves the previous list rather than dropping
// every OpenRouter model.
func TestAStaleListSurvivesALaterFailure(t *testing.T) {
	lister := liveCatalog()
	now := time.Unix(0, 0)
	merged := &Merged{
		Runtime: runtimeCatalog(), OpenRouter: lister,
		TTL: time.Minute, Clock: func() time.Time { return now },
	}
	if _, err := merged.ListModelCatalog(context.Background()); err != nil {
		t.Fatalf("warm: %v", err)
	}
	lister.err = errors.New("network is down")
	lister.models = nil
	now = now.Add(2 * time.Minute) // force a refresh attempt

	models, _ := merged.ListModelCatalog(context.Background())
	if _, ok := find(models, "openrouter", "deepseek/deepseek-v4-flash-0731"); !ok {
		t.Error("the cached list was discarded on a failed refresh")
	}
}

func TestTheCatalogIsCachedWithinItsTTL(t *testing.T) {
	lister := liveCatalog()
	now := time.Unix(0, 0)
	merged := &Merged{
		Runtime: runtimeCatalog(), OpenRouter: lister,
		TTL: time.Minute, Clock: func() time.Time { return now },
	}
	for range 3 {
		if _, err := merged.ListModelCatalog(context.Background()); err != nil {
			t.Fatalf("ListModelCatalog: %v", err)
		}
	}
	if lister.calls != 1 {
		t.Errorf("OpenRouter fetches = %d, want 1 within the TTL", lister.calls)
	}
	now = now.Add(2 * time.Minute)
	if _, err := merged.ListModelCatalog(context.Background()); err != nil {
		t.Fatalf("ListModelCatalog: %v", err)
	}
	if lister.calls != 2 {
		t.Errorf("OpenRouter fetches = %d, want a refresh past the TTL", lister.calls)
	}
}

// A runtime failure is fatal: it means Berry cannot describe any provider, and
// serving only OpenRouter would silently hide every local and direct model.
func TestARuntimeFailurePropagates(t *testing.T) {
	merged := &Merged{
		Runtime:    &stubRuntime{err: errors.New("runtime unavailable")},
		OpenRouter: liveCatalog(),
	}
	if _, err := merged.ListModelCatalog(context.Background()); err == nil {
		t.Error("a runtime failure must not be swallowed")
	}
}
