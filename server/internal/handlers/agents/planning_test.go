package agents

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// Planner role agents Berry provisions are global, so a workspace sync must
// skip them; the manifest limits the runtime reports ride into the projection.
func TestSyncSkipsRoleAgentsAndCarriesManifestLimits(t *testing.T) {
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	roleAgentID, teammateID := uuid.New(), uuid.New()
	maxTokens, perHour := int64(16384), int64(150000)
	runtime := &limitsRuntime{
		summaries: []openfang.AgentSummary{
			{ID: roleAgentID, Name: "berry-planner-3f9a1c2b", State: "Running", CreatedAt: now, LastActive: now, Ready: true},
			{ID: teammateID, Name: "Builder", State: "Running", CreatedAt: now, LastActive: now, Ready: true},
		},
		details: map[uuid.UUID]openfang.AgentDetail{
			teammateID: {ID: teammateID, Name: "Builder", State: "Running", Limits: &openfang.AgentLimits{MaxTokens: &maxTokens, MaxLLMTokensPerHour: &perHour}},
		},
	}
	store := &roleAwareStore{roleAgents: []uuid.UUID{roleAgentID}}
	offered, err := SyncWorkspace(context.Background(), store, runtime, uuid.New(), func() time.Time { return now }, uuid.New)
	if err != nil || offered != 1 {
		t.Fatalf("SyncWorkspace() = %d, %v; want 1 offered", offered, err)
	}
	if len(store.updates) != 1 || store.updates[0].OpenFangAgentID != teammateID {
		t.Fatalf("updates = %+v, want only the teammate", store.updates)
	}
	if limits := store.updates[0].ManifestLimits; limits == nil || *limits.MaxTokens != 16384 || *limits.MaxLLMTokensPerHour != 150000 {
		t.Fatalf("manifest limits = %+v", store.updates[0].ManifestLimits)
	}
}

// The detail response's limits decode from either wire placement and are
// null when the runtime reports none.
func TestAgentDetailLimitsDecodeFromEitherPlacement(t *testing.T) {
	for name, body := range map[string]string{
		"top-level": `{"max_tokens": 4096, "max_llm_tokens_per_hour": 150000}`,
		"nested":    `{"limits": {"max_tokens": 4096, "max_llm_tokens_per_hour": 150000}}`,
	} {
		var wire struct {
			MaxTokens           *int64 `json:"max_tokens"`
			MaxLLMTokensPerHour *int64 `json:"max_llm_tokens_per_hour"`
			Limits              *struct {
				MaxTokens           *int64 `json:"max_tokens"`
				MaxLLMTokensPerHour *int64 `json:"max_llm_tokens_per_hour"`
			} `json:"limits"`
		}
		if err := json.Unmarshal([]byte(body), &wire); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		limits := openfang.AgentLimits{MaxTokens: wire.MaxTokens, MaxLLMTokensPerHour: wire.MaxLLMTokensPerHour}
		if wire.Limits != nil {
			limits = openfang.AgentLimits{MaxTokens: wire.Limits.MaxTokens, MaxLLMTokensPerHour: wire.Limits.MaxLLMTokensPerHour}
		}
		if limits.MaxTokens == nil || *limits.MaxTokens != 4096 || limits.MaxLLMTokensPerHour == nil {
			t.Fatalf("%s: limits = %+v", name, limits)
		}
	}
	if decodeLimits(nil) != nil || decodeLimits([]byte(`{}`)) != nil {
		t.Fatal("empty limits must decode to nil")
	}
}

// The capabilities route reads the stored projection: skills as
// capabilities, runtime tools, availability from the run count, limits, and
// the orchestrator flag.
func TestCapabilitiesRouteServesTheRegistryView(t *testing.T) {
	maxTokens := int64(8192)
	store := &roleAwareStore{capabilities: []AgentCapability{
		{Agent: Agent{ID: uuid.New(), Name: "Builder", Status: "available", Capabilities: []string{"shell"}, Skills: []string{"backend"},
			ManifestLimits: &openfang.AgentLimits{MaxTokens: &maxTokens}}, ActiveRuns: 0},
		{Agent: Agent{ID: uuid.New(), Name: "Orchestrator", Status: "busy", Capabilities: []string{}}, ActiveRuns: 1, Protected: true},
	}}
	mount, err := NewMount(Options{Store: store, Sessions: agentSessions{}, Authorization: agentAuthorizer{}, Clock: time.Now, NewID: uuid.New, OpenFang: &agentRuntime{}})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/capabilities", nil)
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	response := httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)
	body := response.Body.String()
	if response.Code != http.StatusOK || !strings.Contains(body, `"capabilities":["backend"]`) || !strings.Contains(body, `"tools":["shell"]`) ||
		!strings.Contains(body, `"eligible":true`) || !strings.Contains(body, `"maxTokens":8192`) ||
		!strings.Contains(body, `"isOrchestrator":true`) || !strings.Contains(body, `"activeRuns":1,"maxConcurrentRuns":1},"limits":null`) {
		t.Fatalf("capabilities = %d %s", response.Code, body)
	}
}

// The skills grammar is enforced before anything is stored.
func TestNormaliseSkillsLowercasesDedupesAndRefusesBadNames(t *testing.T) {
	skills, ok := normaliseSkills([]string{"Backend", "frontend", " backend "})
	if !ok || len(skills) != 2 || skills[0] != "backend" || skills[1] != "frontend" {
		t.Fatalf("normaliseSkills = %v, %v", skills, ok)
	}
	if _, ok := normaliseSkills([]string{"bad skill"}); ok {
		t.Fatal("a skill with a space was accepted")
	}
	if _, ok := normaliseSkills(make([]string, maxSkills+1)); ok {
		t.Fatal("too many skills accepted")
	}
}

type limitsRuntime struct {
	summaries []openfang.AgentSummary
	details   map[uuid.UUID]openfang.AgentDetail
}

func (runtime *limitsRuntime) ListAgents(context.Context) ([]openfang.AgentSummary, error) {
	return runtime.summaries, nil
}
func (runtime *limitsRuntime) GetAgent(_ context.Context, id uuid.UUID) (openfang.AgentDetail, error) {
	return runtime.details[id], nil
}

type roleAwareStore struct {
	agentStore
	roleAgents   []uuid.UUID
	capabilities []AgentCapability
}

func (store *roleAwareStore) RoleAgentIDs(context.Context) ([]uuid.UUID, error) {
	return store.roleAgents, nil
}
func (store *roleAwareStore) ListCapabilities(context.Context, uuid.UUID) ([]AgentCapability, error) {
	return store.capabilities, nil
}
