// Package modelcatalog assembles the models an agent can be switched to.
//
// The runtime reports one catalog, but its OpenRouter half is compiled into the
// binary and goes stale: a model published after that build is absent, so a
// working pairing reads as unavailable and cannot be selected. OpenRouter
// publishes its own catalog live, so this replaces the runtime's OpenRouter
// entries with it and keeps the runtime's entries for every other provider,
// which Berry does not talk to directly.
package modelcatalog

import (
	"context"
	"sync"
	"time"

	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/openrouter"
)

// ProviderOpenRouter is the provider whose entries are replaced.
const ProviderOpenRouter = "openrouter"

// Lister is the narrow seam onto OpenRouter's catalog, kept separate so a test
// does not need an HTTP server.
type Lister interface {
	ListModels(context.Context) ([]openrouter.Model, error)
}

// Merged serves the runtime catalog with OpenRouter's entries refreshed.
type Merged struct {
	Runtime    openfang.Catalog
	OpenRouter Lister
	// TTL bounds how stale the OpenRouter half may be. The list changes on
	// OpenRouter's release schedule, not Berry's, so a short cache costs
	// nothing and spares every picker render a 400-model fetch.
	TTL   time.Duration
	Clock func() time.Time

	mu        sync.Mutex
	cached    []openrouter.Model
	cachedAt  time.Time
	cacheGood bool
}

const defaultTTL = 15 * time.Minute

// ListModelCatalog returns the merged catalog.
//
// OpenRouter being unreachable is not fatal: the runtime's compiled entries are
// served instead. They are stale, which is the flaw this package exists to fix,
// but a stale picker beats an empty one.
func (merged *Merged) ListModelCatalog(ctx context.Context) ([]openfang.CatalogModel, error) {
	if merged == nil || merged.Runtime == nil {
		return nil, nil
	}
	runtime, err := merged.Runtime.ListModelCatalog(ctx)
	if err != nil {
		return nil, err
	}
	live, ok := merged.liveModels(ctx)
	if !ok {
		return runtime, nil
	}

	// Drop the runtime's OpenRouter entries; the live list replaces them
	// wholesale rather than merging per-id, so a model OpenRouter has retired
	// does not linger because an old build still remembers it.
	out := make([]openfang.CatalogModel, 0, len(runtime)+len(live))
	for _, model := range runtime {
		if model.Provider == ProviderOpenRouter {
			continue
		}
		out = append(out, model)
	}
	for _, model := range live {
		out = append(out, openfang.CatalogModel{
			ID:             model.ID,
			DisplayName:    model.DisplayName,
			Provider:       ProviderOpenRouter,
			ContextWindow:  model.ContextWindow,
			InputCostPerM:  model.InputCostPerM,
			OutputCostPerM: model.OutputCostPerM,
			SupportsTools:  model.SupportsTools,
			SupportsVision: model.SupportsVision,
			// OpenRouter lists what it serves. Whether a given request is
			// affordable is a spend question answered at dispatch, not a
			// catalog property.
			Available: true,
		})
	}
	return out, nil
}

// liveModels returns the cached OpenRouter catalog, refreshing when stale.
// The second result is false when no usable list is available.
func (merged *Merged) liveModels(ctx context.Context) ([]openrouter.Model, bool) {
	if merged.OpenRouter == nil {
		return nil, false
	}
	clock := merged.Clock
	if clock == nil {
		clock = time.Now
	}
	ttl := merged.TTL
	if ttl <= 0 {
		ttl = defaultTTL
	}

	merged.mu.Lock()
	defer merged.mu.Unlock()
	if merged.cacheGood && clock().Sub(merged.cachedAt) < ttl {
		return merged.cached, true
	}
	models, err := merged.OpenRouter.ListModels(ctx)
	if err != nil || len(models) == 0 {
		// Serve the previous list rather than nothing: a transient fetch
		// failure should not empty a picker that worked a minute ago.
		return merged.cached, merged.cacheGood
	}
	merged.cached = models
	merged.cachedAt = clock()
	merged.cacheGood = true
	return models, true
}
