package agents

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Under the ADK runtime an agent is a Berry row, not a projection of somebody
// else's. These cover the difference that matters: nothing upstream is asked,
// so an agent OpenFang has never heard of is listed and read as it is rather
// than marked offline and stripped of the model Berry gave it.

func TestBerryOwnedAgentsAreListedWithoutReconciling(t *testing.T) {
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	runtime := &agentRuntime{}
	store := &agentStore{agent: Agent{
		ID:           uuid.New(),
		Name:         "ADK Writer",
		Status:       "available",
		Capabilities: []string{},
		CreatedAt:    now,
		UpdatedAt:    now,
	}}
	mount := newBerryOwnedMount(t, store, runtime, now)

	request := httptest.NewRequest(http.MethodGet, "/?first=10", nil)
	request.Header.Set("Authorization", "Bearer "+agentTestToken())
	response := httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if runtime.lists.Load() != 0 {
		t.Fatalf("runtime list calls = %d, want 0", runtime.lists.Load())
	}
	if len(store.updates) != 0 {
		t.Fatalf("updates = %#v, want none", store.updates)
	}

	var body struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Nodes) != 1 || body.Nodes[0]["name"] != "ADK Writer" {
		t.Fatalf("nodes = %#v", body.Nodes)
	}
	// The status the row carries, not the "offline" a failed reconcile would
	// have written over it.
	if body.Nodes[0]["status"] != "available" {
		t.Fatalf("status = %v, want available", body.Nodes[0]["status"])
	}
}

func TestBerryOwnedAgentIsReadWithoutAskingUpstream(t *testing.T) {
	now := time.Date(2026, time.August, 27, 12, 0, 0, 0, time.UTC)
	id := uuid.New()
	model := "anthropic/claude-sonnet-4.5"
	runtime := &agentRuntime{}
	store := &agentStore{agent: Agent{
		ID:           id,
		Name:         "ADK Writer",
		Status:       "available",
		Capabilities: []string{},
		ModelName:    &model,
		CreatedAt:    now,
		UpdatedAt:    now,
	}}
	mount := newBerryOwnedMount(t, store, runtime, now)

	request := httptest.NewRequest(http.MethodGet, "/"+id.String(), nil)
	request.Header.Set("Authorization", "Bearer "+agentTestToken())
	response := httptest.NewRecorder()
	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if runtime.details.Load() != 0 {
		t.Fatalf("runtime detail calls = %d, want 0", runtime.details.Load())
	}

	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	// The model is Berry's now. A reconcile would have replaced it with
	// whatever OpenFang last reported, which for an agent it does not know is
	// nothing at all.
	if body["modelName"] != model {
		t.Fatalf("modelName = %v, want %s", body["modelName"], model)
	}
	if body["status"] != "available" {
		t.Fatalf("status = %v, want available", body["status"])
	}
}

func newBerryOwnedMount(t *testing.T, store Store, runtime *agentRuntime, now time.Time) httpMount {
	t.Helper()
	mount, err := NewMount(Options{
		Store:                store,
		Sessions:             agentSessions{},
		Authorization:        agentAuthorizer{},
		Clock:                func() time.Time { return now },
		NewID:                uuid.New,
		OpenFang:             runtime,
		SkipRuntimeReconcile: true,
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return httpMount{Handler: mount.Handler}
}
