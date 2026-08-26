package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

type fixedPrices struct{ table map[string]Price }

func (prices fixedPrices) Price(_ context.Context, provider, model string) (Price, bool) {
	price, ok := prices.table[provider+"/"+model]
	return price, ok
}

// A role call is one user message with a JSON-object response format sent to
// the role's upstream agent name; usage is priced through the catalog; a
// 429 maps to ErrRateLimited without a retry; an unprovisioned role is
// refused before any request; an oversized task never leaves the process.
func TestOpenFangGatewayCompletesThroughTheRoleAgent(t *testing.T) {
	var calls int
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		_ = json.NewDecoder(request.Body).Decode(&received)
		if received["model"] == "berry-critic-limited" {
			response.WriteHeader(http.StatusTooManyRequests)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Request-Id", "req_role_1")
		_, _ = io.WriteString(response, `{"object":"chat.completion","choices":[{"message":{"role":"assistant","content":"{\"goal\":\"x\"}"}}],"usage":{"prompt_tokens":1000,"completion_tokens":500}}`)
	}))
	defer server.Close()
	client, err := openfang.New(server.URL, "", server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("openfang.New() error = %v", err)
	}
	store := newMemoryStore()
	store.rows[RolePlanner] = RoleAgent{Role: RolePlanner, OpenFangAgentID: uuid.New(), UpstreamName: "berry-planner-abc", Provider: "openrouter", Model: "anthropic/claude-sonnet-4", PromptVersion: "planner-v1", Status: StatusAvailable}
	store.rows[RoleCritic] = RoleAgent{Role: RoleCritic, OpenFangAgentID: uuid.New(), UpstreamName: "berry-critic-limited", Provider: "openrouter", Model: "m", PromptVersion: "critic-v1", Status: StatusAvailable}
	store.rows[RoleRepair] = RoleAgent{Role: RoleRepair, OpenFangAgentID: uuid.New(), UpstreamName: "berry-repair-off", Provider: "openrouter", Model: "m", PromptVersion: "repair-v1", Status: StatusOffline}
	gateway, err := NewOpenFang(client, store, fixedPrices{table: map[string]Price{"openrouter/anthropic/claude-sonnet-4": {InputPerMillion: 3, OutputPerMillion: 15}}})
	if err != nil {
		t.Fatalf("NewOpenFang() error = %v", err)
	}
	reply, err := gateway.Complete(context.Background(), RolePlanner, Request{User: "Plan this.", SchemaName: "BerryPlan"})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if received["model"] != "berry-planner-abc" {
		t.Fatalf("model = %v", received["model"])
	}
	if format, _ := received["response_format"].(map[string]any); format["type"] != "json_object" {
		t.Fatalf("response_format = %v", received["response_format"])
	}
	messages, _ := received["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("messages = %v, want one user message", messages)
	}
	if reply.Content != `{"goal":"x"}` || reply.InputTokens != 1000 || reply.OutputTokens != 500 || reply.RequestID != "req_role_1" ||
		reply.Provider != "openrouter" || reply.Model != "anthropic/claude-sonnet-4" || reply.PromptVersion != "planner-v1" {
		t.Fatalf("reply = %+v", reply)
	}
	// 1000 × $3/M + 500 × $15/M = $0.0105 = 10500 micro-dollars.
	if reply.CostMicros == nil || *reply.CostMicros != 10500 {
		t.Fatalf("cost = %v, want 10500", reply.CostMicros)
	}

	calls = 0
	if _, err := gateway.Complete(context.Background(), RoleCritic, Request{User: "Review."}); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate limited call error = %v, want ErrRateLimited", err)
	}
	if calls != 1 {
		t.Fatalf("rate-limited call made %d requests, want exactly one", calls)
	}
	calls = 0
	if _, err := gateway.Complete(context.Background(), RoleRepair, Request{User: "Repair."}); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("offline role error = %v, want ErrRoleUnavailable", err)
	}
	if _, err := gateway.Complete(context.Background(), RoleClassifier, Request{User: "Classify."}); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("missing role error = %v, want ErrRoleUnavailable", err)
	}
	if _, err := gateway.Complete(context.Background(), RolePlanner, Request{User: string(make([]byte, openfang.MaxChatContentBytes+1))}); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized error = %v, want ErrRequestTooLarge", err)
	}
	if calls != 0 {
		t.Fatalf("refused calls reached the server: %d", calls)
	}
	if err := gateway.Ready(context.Background()); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("Ready() with a missing role = %v", err)
	}
	store.rows[RoleClassifier] = RoleAgent{Role: RoleClassifier, Status: StatusAvailable}
	store.rows[RoleRepair] = RoleAgent{Role: RoleRepair, Status: StatusAvailable}
	if err := gateway.Ready(context.Background()); err != nil {
		t.Fatalf("Ready() = %v", err)
	}
}

type fakeCatalog struct {
	calls  int
	models []openfang.CatalogModel
}

func (catalog *fakeCatalog) ListModelCatalog(context.Context) ([]openfang.CatalogModel, error) {
	catalog.calls++
	return catalog.models, nil
}

func TestCatalogPricesCacheTheTable(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	catalog := &fakeCatalog{models: []openfang.CatalogModel{
		{ID: "anthropic/claude-sonnet-4", Provider: "openrouter", InputCostPerM: 3, OutputCostPerM: 15},
		{ID: "minimax/minimax-m2.7:free", Provider: "openrouter"},
	}}
	prices := &CatalogPrices{Catalog: catalog, TTL: time.Minute, Clock: func() time.Time { return now }}
	price, ok := prices.Price(context.Background(), "openrouter", "anthropic/claude-sonnet-4")
	if !ok || price.InputPerMillion != 3 || price.OutputPerMillion != 15 {
		t.Fatalf("Price() = %+v %v", price, ok)
	}
	if _, ok := prices.Price(context.Background(), "openrouter", "minimax/minimax-m2.7:free"); ok {
		t.Fatal("a free model has no price")
	}
	if catalog.calls != 1 {
		t.Fatalf("catalog calls = %d, want 1 (cached)", catalog.calls)
	}
	now = now.Add(2 * time.Minute)
	_, _ = prices.Price(context.Background(), "openrouter", "anthropic/claude-sonnet-4")
	if catalog.calls != 2 {
		t.Fatalf("catalog calls after TTL = %d, want 2", catalog.calls)
	}
	if CostMicros(1_000_000, 0, Price{InputPerMillion: 2.5}) != 2_500_000 || CostMicros(0, 10, Price{OutputPerMillion: -1}) != 0 {
		t.Fatal("CostMicros arithmetic")
	}
}
