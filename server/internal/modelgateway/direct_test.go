package modelgateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openrouter"
)

func directPrompts() map[Role]Prompt {
	return map[Role]Prompt{
		RoleClassifier: {Version: "classifier-v1", Text: "You classify."},
		RolePlanner:    {Version: "planner-v1", Text: "You plan carefully."},
		RoleRepair:     {Version: "repair-v1", Text: "You repair."},
		RoleCritic:     {Version: "critic-v1", Text: "You criticise."},
	}
}

func TestDirectGatewayCallsTheRolesOwnModel(t *testing.T) {
	var calls int
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls++
		_ = json.NewDecoder(request.Body).Decode(&received)
		if received["model"] == "rate/limited" {
			response.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(response, `{"error":{"message":"slow down"}}`)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		response.Header().Set("X-Request-Id", "req_direct_1")
		_, _ = io.WriteString(response, `{"choices":[{"message":{"content":"{\"goal\":\"x\"}"}}],"usage":{"prompt_tokens":1000,"completion_tokens":500}}`)
	}))
	defer server.Close()

	client := openrouter.New(server.URL, server.Client(), openrouter.WithAPIKey("test-key"))
	store := newMemoryStore()
	store.rows[RolePlanner] = RoleAgent{
		Role: RolePlanner, Provider: "openrouter", Model: "anthropic/claude-sonnet-4",
		PromptVersion: "planner-v1", Status: StatusAvailable,
	}
	store.rows[RoleCritic] = RoleAgent{
		Role: RoleCritic, Provider: "openrouter", Model: "rate/limited",
		PromptVersion: "critic-v1", Status: StatusAvailable,
	}
	store.rows[RoleRepair] = RoleAgent{
		Role: RoleRepair, Provider: "openrouter", Model: "m",
		PromptVersion: "repair-v1", Status: StatusOffline,
	}
	gateway, err := NewDirect(client, store, directPrompts(),
		fixedPrices{table: map[string]Price{
			"openrouter/anthropic/claude-sonnet-4": {InputPerMillion: 3, OutputPerMillion: 15},
		}})
	if err != nil {
		t.Fatalf("NewDirect() error = %v", err)
	}

	reply, err := gateway.Complete(context.Background(), RolePlanner, Request{User: "Plan this."})
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	// The model, not an agent name: the runtime resolved one to the other and
	// Berry already holds the answer.
	if received["model"] != "anthropic/claude-sonnet-4" {
		t.Fatalf("model = %v, want the role's model", received["model"])
	}
	// Two messages now, where the runtime path sent one. The system turn is
	// the prompt OpenFang used to hold inside the agent; without it the role
	// is a different role, and the difference shows up as worse output rather
	// than as an error.
	messages, _ := received["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("messages = %v, want a system and a user turn", messages)
	}
	first, _ := messages[0].(map[string]any)
	if first["role"] != "system" || first["content"] != "You plan carefully." {
		t.Fatalf("first message = %v, want the role's prompt", first)
	}
	if format, _ := received["response_format"].(map[string]any); format["type"] != "json_object" {
		t.Fatalf("response_format = %v", received["response_format"])
	}
	if reply.Content != `{"goal":"x"}` || reply.InputTokens != 1000 || reply.OutputTokens != 500 ||
		reply.RequestID != "req_direct_1" || reply.Provider != "openrouter" ||
		reply.Model != "anthropic/claude-sonnet-4" || reply.PromptVersion != "planner-v1" {
		t.Fatalf("reply = %+v", reply)
	}
	// 1000 × $3/M + 500 × $15/M = $0.0105 = 10500 micro-dollars.
	if reply.CostMicros == nil || *reply.CostMicros != 10500 {
		t.Fatalf("cost = %v, want 10500", reply.CostMicros)
	}

	calls = 0
	rateLimited, err := gateway.Complete(context.Background(), RoleCritic, Request{User: "Review."})
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("rate limited error = %v, want ErrRateLimited", err)
	}
	if calls != 1 {
		t.Fatalf("rate-limited call made %d requests, want exactly one", calls)
	}
	// A failed call still names what was attempted, because a ledger row that
	// names nothing is one nobody can act on.
	if rateLimited.Model != "rate/limited" || rateLimited.PromptVersion != "critic-v1" {
		t.Fatalf("rate limited reply = %+v, want the attempt described", rateLimited)
	}

	calls = 0
	if _, err := gateway.Complete(context.Background(), RoleRepair, Request{User: "Repair."}); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("offline role error = %v, want ErrRoleUnavailable", err)
	}
	if _, err := gateway.Complete(context.Background(), RoleClassifier, Request{User: "Classify."}); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("missing role error = %v, want ErrRoleUnavailable", err)
	}
	oversized := string(make([]byte, openrouter.MaxChatContentBytes+1))
	if _, err := gateway.Complete(context.Background(), RolePlanner, Request{User: oversized}); !errors.Is(err, ErrRequestTooLarge) {
		t.Fatalf("oversized error = %v, want ErrRequestTooLarge", err)
	}
	if calls != 0 {
		t.Fatalf("refused calls reached the server: %d", calls)
	}
}

// A role row with no model cannot be called at all. Under the runtime the
// agent name was enough and this could not arise, so it is refused as
// unavailable rather than sent as an empty model the provider rejects.
func TestDirectGatewayRefusesARoleWithNoModel(t *testing.T) {
	store := newMemoryStore()
	store.rows[RolePlanner] = RoleAgent{Role: RolePlanner, Provider: "openrouter", Status: StatusAvailable}
	gateway, err := NewDirect(
		openrouter.New("", nil, openrouter.WithAPIKey("k")), store, directPrompts(), nil)
	if err != nil {
		t.Fatalf("NewDirect() error = %v", err)
	}
	if _, err := gateway.Complete(context.Background(), RolePlanner, Request{User: "Plan."}); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("error = %v, want ErrRoleUnavailable", err)
	}
}

// Readiness has to check the prompt too. A role that is available and has a
// model but no prompt would pass the runtime path's check and then call the
// model with no instructions at all.
func TestDirectGatewayReadinessChecksModelAndPrompt(t *testing.T) {
	store := newMemoryStore()
	for _, role := range Roles {
		store.rows[role] = RoleAgent{Role: role, Provider: "openrouter", Model: "m", Status: StatusAvailable}
	}
	prompts := directPrompts()
	gateway, err := NewDirect(openrouter.New("", nil, openrouter.WithAPIKey("k")), store, prompts, nil)
	if err != nil {
		t.Fatalf("NewDirect() error = %v", err)
	}
	if err := gateway.Ready(context.Background()); err != nil {
		t.Fatalf("Ready() = %v", err)
	}

	store.rows[RolePlanner] = RoleAgent{Role: RolePlanner, Provider: "openrouter", Status: StatusAvailable}
	if err := gateway.Ready(context.Background()); !errors.Is(err, ErrRoleUnavailable) {
		t.Fatalf("Ready() with a modelless role = %v, want ErrRoleUnavailable", err)
	}
}

func TestNewDirectRefusesWithoutPrompts(t *testing.T) {
	if _, err := NewDirect(
		openrouter.New("", nil, openrouter.WithAPIKey("k")), newMemoryStore(), nil, nil,
	); err == nil {
		t.Fatal("NewDirect() with no prompts should fail")
	}
}

func TestEnsureLocalRoleAgentsRecordsWhatTheDeploymentConfigured(t *testing.T) {
	store := newMemoryStore()
	specs := RoleSpecs{
		Classifier: RoleSpec{Provider: "openrouter", Model: "a/classifier"},
		Planner:    RoleSpec{Provider: "openrouter", Model: "a/planner"},
		Repair:     RoleSpec{Provider: "openrouter", Model: "a/repair"},
		Critic:     RoleSpec{Provider: "openrouter", Model: "a/critic"},
	}
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	if err := EnsureLocalRoleAgents(
		context.Background(), store, specs, directPrompts(), func() time.Time { return now },
	); err != nil {
		t.Fatalf("EnsureLocalRoleAgents() error = %v", err)
	}

	for _, role := range Roles {
		row, ok := store.rows[role]
		if !ok {
			t.Fatalf("%s was not recorded", role)
		}
		if row.Status != StatusAvailable || row.Model == "" || row.PromptVersion == "" {
			t.Errorf("%s = %+v, want an available, configured role", role, row)
		}
		// Nothing upstream owns the role any more, and a nil id is the honest
		// value for that rather than a UUID naming an agent that never existed.
		if row.OpenFangAgentID != uuid.Nil {
			t.Errorf("%s carries an upstream id %s", role, row.OpenFangAgentID)
		}
	}
}

// Berry does not choose an LLM for an operator, so an unconfigured role stays
// uncallable and says so — rather than silently running on a default nobody
// picked.
func TestEnsureLocalRoleAgentsRefusesAnUnconfiguredRole(t *testing.T) {
	store := newMemoryStore()
	specs := RoleSpecs{Planner: RoleSpec{Provider: "openrouter", Model: "a/planner"}}

	err := EnsureLocalRoleAgents(
		context.Background(), store, specs, directPrompts(), time.Now)
	if err == nil {
		t.Fatal("EnsureLocalRoleAgents() should report the unconfigured roles")
	}
	if _, ok := store.rows[RolePlanner]; !ok {
		t.Error("the configured role should still have been recorded")
	}
	if _, ok := store.rows[RoleCritic]; ok {
		t.Error("an unconfigured role must not be recorded")
	}
}
