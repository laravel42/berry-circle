package agents

import (
	"context"
	"net/http"
	"sort"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// modelResource is one selectable LLM as the product sees it.
type modelResource struct {
	ID             string  `json:"id"`
	DisplayName    string  `json:"displayName"`
	Provider       string  `json:"provider"`
	Tier           string  `json:"tier"`
	ContextWindow  int64   `json:"contextWindow"`
	InputCostPerM  float64 `json:"inputCostPerM"`
	OutputCostPerM float64 `json:"outputCostPerM"`
	SupportsTools  bool    `json:"supportsTools"`
	SupportsVision bool    `json:"supportsVision"`
}

// modelsHandler lists the models an agent can actually be switched to.
//
// Only models the runtime reports as available are returned. The catalog also
// carries models whose provider has no credential configured; offering one
// would let an operator pick a model that fails on the agent's next task, with
// nothing at selection time to explain why.
func modelsHandler(catalog openfang.Catalog, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		models, err := catalog.ListModelCatalog(request.Context())
		if err != nil {
			writeDependencyError(response, request, err)
			return
		}
		nodes := make([]modelResource, 0, len(models))
		for _, model := range models {
			if !model.Available || model.ID == "" {
				continue
			}
			id := normalizeModelID(model.Provider, model.ID)
			nodes = append(nodes, modelResource{
				ID:             id,
				DisplayName:    firstNonEmpty(model.DisplayName, id),
				Provider:       model.Provider,
				Tier:           model.Tier,
				ContextWindow:  model.ContextWindow,
				InputCostPerM:  model.InputCostPerM,
				OutputCostPerM: model.OutputCostPerM,
				SupportsTools:  model.SupportsTools,
				SupportsVision: model.SupportsVision,
			})
		}
		// Grouped by provider, cheapest first inside it: the list is read as
		// "who serves this, and what does it cost".
		sort.SliceStable(nodes, func(a, b int) bool {
			if nodes[a].Provider != nodes[b].Provider {
				return nodes[a].Provider < nodes[b].Provider
			}
			if nodes[a].InputCostPerM != nodes[b].InputCostPerM {
				return nodes[a].InputCostPerM < nodes[b].InputCostPerM
			}
			return nodes[a].DisplayName < nodes[b].DisplayName
		})
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
	}
}

// resolveModel confirms a provider/model pair exists and is usable, returning
// the catalog entry. Validating here means a bad pair is refused at selection
// rather than discovered when the agent next runs.
func resolveModel(
	ctx context.Context,
	catalog openfang.Catalog,
	provider, model string,
) (openfang.CatalogModel, bool) {
	models, err := catalog.ListModelCatalog(ctx)
	if err != nil {
		return openfang.CatalogModel{}, false
	}
	// Both sides are normalised: the catalog because the runtime prefixes some
	// ids with their provider, and the request because a client written against
	// the un-normalised catalog sends that prefixed form back.
	wanted := normalizeModelID(provider, model)
	for _, candidate := range models {
		if !candidate.Available || candidate.Provider != provider {
			continue
		}
		if normalizeModelID(candidate.Provider, candidate.ID) == wanted {
			return candidate, true
		}
	}
	return openfang.CatalogModel{}, false
}

// normalizeModelID strips a provider prefix the runtime redundantly repeats
// inside a model id.
//
// The catalog is inconsistent about it: an OpenRouter entry reports provider
// "openrouter" with id "openrouter/anthropic/claude-sonnet-4", while an
// Anthropic entry reports provider "anthropic" with id "claude-sonnet-4-6".
// The provider already travels in its own field, so a client keying a model as
// provider + "/" + id doubles the prefix for the first and not the second — and
// the pair an agent actually stores ("openrouter", "anthropic/claude-sonnet-4")
// then matches neither, which is why a configured model read as unavailable.
//
// Normalising here rather than in the client keeps one form on the wire: this
// is the adapter boundary whose job is reconciling upstream shapes, and every
// consumer would otherwise have to know the quirk.
func normalizeModelID(provider, id string) string {
	if provider == "" || id == "" {
		return id
	}
	return strings.TrimPrefix(id, provider+"/")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
