package agents

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// stubCatalog serves a fixed catalog, shaped like the runtime's real one: an
// OpenRouter entry repeats its provider inside the id, a direct-provider entry
// does not, and one entry is unavailable.
type stubCatalog struct {
	models []openfang.CatalogModel
	err    error
}

func (catalog stubCatalog) ListModelCatalog(context.Context) ([]openfang.CatalogModel, error) {
	return catalog.models, catalog.err
}

func runtimeShapedCatalog() stubCatalog {
	return stubCatalog{models: []openfang.CatalogModel{
		{
			ID:        "openrouter/anthropic/claude-sonnet-4",
			Provider:  "openrouter",
			Available: true,
		},
		{
			ID:        "claude-sonnet-4-6",
			Provider:  "anthropic",
			Available: true,
		},
		{
			ID:        "openrouter/deepseek/deepseek-chat",
			Provider:  "openrouter",
			Available: false,
		},
	}}
}

// The id an agent stores is the manifest form — provider in its own field, no
// prefix on the model. Before normalisation the catalog reported the prefixed
// form, so a client keying provider + "/" + id could never match a configured
// agent and every OpenRouter model read as "not offered by this runtime".
func TestModelsHandlerStripsTheRedundantProviderPrefix(t *testing.T) {
	response := httptest.NewRecorder()
	modelsHandler(runtimeShapedCatalog(), Options{})(
		response, httptest.NewRequest(http.MethodGet, "/agents/models", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	var body struct {
		Nodes []modelResource `json:"nodes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2 (the unavailable model must not be offered)", len(body.Nodes))
	}
	byProvider := map[string]string{}
	for _, node := range body.Nodes {
		byProvider[node.Provider] = node.ID
	}
	if got := byProvider["openrouter"]; got != "anthropic/claude-sonnet-4" {
		t.Errorf("openrouter id = %q, want %q", got, "anthropic/claude-sonnet-4")
	}
	// A provider that never prefixed its ids must pass through untouched.
	if got := byProvider["anthropic"]; got != "claude-sonnet-4-6" {
		t.Errorf("anthropic id = %q, want %q", got, "claude-sonnet-4-6")
	}
}

func TestResolveModelAcceptsBothTheStoredAndPrefixedForms(t *testing.T) {
	catalog := runtimeShapedCatalog()
	for _, testCase := range []struct {
		name            string
		provider, model string
		want            bool
	}{
		{"stored form", "openrouter", "anthropic/claude-sonnet-4", true},
		// A client written against the un-normalised catalog sends this back.
		{"prefixed form", "openrouter", "openrouter/anthropic/claude-sonnet-4", true},
		{"unprefixed provider", "anthropic", "claude-sonnet-4-6", true},
		{"unavailable model", "openrouter", "deepseek/deepseek-chat", false},
		{"wrong provider", "anthropic", "anthropic/claude-sonnet-4", false},
		{"unknown model", "openrouter", "vendor/not-real", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			_, ok := resolveModel(context.Background(), catalog, testCase.provider, testCase.model)
			if ok != testCase.want {
				t.Errorf("resolveModel(%q, %q) = %v, want %v",
					testCase.provider, testCase.model, ok, testCase.want)
			}
		})
	}
}

func TestNormalizeModelIDLeavesUnrelatedValuesAlone(t *testing.T) {
	for _, testCase := range []struct{ provider, id, want string }{
		{"openrouter", "openrouter/anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4"},
		{"anthropic", "claude-sonnet-4-6", "claude-sonnet-4-6"},
		// Only an exact "provider/" prefix is redundant; a coincidental
		// substring is part of the model's real name.
		{"open", "openrouter/model", "openrouter/model"},
		{"", "anything", "anything"},
		{"openrouter", "", ""},
	} {
		if got := normalizeModelID(testCase.provider, testCase.id); got != testCase.want {
			t.Errorf("normalizeModelID(%q, %q) = %q, want %q",
				testCase.provider, testCase.id, got, testCase.want)
		}
	}
}
