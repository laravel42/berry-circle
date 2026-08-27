package agents

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
)

func TestAgentMountRequiresAuthentication(t *testing.T) {
	runtime := &agentRuntime{}
	mount := newAgentTestMount(t, &agentStore{}, runtime)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	response := httptest.NewRecorder()

	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
	if runtime.lists.Load() != 0 {
		t.Fatalf("runtime list calls = %d, want 0", runtime.lists.Load())
	}
}

func TestAgentListReconcilesAndReturnsBerryIdentity(t *testing.T) {
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	upstreamID := uuid.New()
	berryID := uuid.New()
	runtime := &agentRuntime{summaries: []openfang.AgentSummary{{
		ID:            upstreamID,
		Name:          "Builder",
		State:         "Running",
		CreatedAt:     now.Add(-time.Hour),
		LastActive:    now,
		ModelProvider: "provider-secret-name",
		ModelName:     "runtime-model",
		Ready:         true,
	}}}
	store := &agentStore{}
	mount := newAgentTestMountWithID(t, store, runtime, berryID, now)
	request := httptest.NewRequest(http.MethodGet, "/?first=10", nil)
	request.Header.Set("Authorization", "Bearer "+agentTestToken())
	response := httptest.NewRecorder()

	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if len(store.updates) != 1 ||
		store.updates[0].OpenFangAgentID != upstreamID ||
		store.updates[0].ID != berryID {
		t.Fatalf("updates = %#v", store.updates)
	}
	var body struct {
		Nodes []map[string]any `json:"nodes"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(body.Nodes) != 1 || body.Nodes[0]["id"] != berryID.String() {
		t.Fatalf("nodes = %#v", body.Nodes)
	}
	encoded := response.Body.String()
	if strings.Contains(encoded, "provider-secret-name") ||
		strings.Contains(encoded, "runtime-model") ||
		strings.Contains(encoded, upstreamID.String()) {
		t.Fatalf("provider metadata leaked in %s", encoded)
	}
}

func TestAgentListRejectsInvalidFilterBeforeRuntimeCall(t *testing.T) {
	runtime := &agentRuntime{}
	mount := newAgentTestMount(t, &agentStore{}, runtime)
	request := httptest.NewRequest(http.MethodGet, "/?status=invalid", nil)
	request.Header.Set("Authorization", "Bearer "+agentTestToken())
	response := httptest.NewRecorder()

	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if runtime.lists.Load() != 0 {
		t.Fatalf("runtime list calls = %d, want 0", runtime.lists.Load())
	}
}

func newAgentTestMount(
	t *testing.T,
	store Store,
	runtime openfang.Runtime,
) httpMount {
	t.Helper()
	return newAgentTestMountWithID(
		t,
		store,
		runtime,
		uuid.New(),
		time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC),
	)
}

func newAgentTestMountWithID(
	t *testing.T,
	store Store,
	runtime openfang.Runtime,
	id uuid.UUID,
	now time.Time,
) httpMount {
	t.Helper()
	mount, err := NewMount(Options{
		Store:         store,
		Sessions:      agentSessions{},
		Authorization: agentAuthorizer{},
		Clock:         func() time.Time { return now },
		NewID:         func() uuid.UUID { return id },
		OpenFang:      runtime,
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return httpMount{Handler: mount.Handler}
}

type httpMount struct {
	Handler http.Handler
}

type agentSessions struct{}

func (agentSessions) ResolveSession(context.Context, string) (auth.User, error) {
	workspaceID := agentTestWorkspaceID
	return auth.User{
		ID:                 uuid.New(),
		Role:               auth.RoleMember,
		CurrentWorkspaceID: &workspaceID,
	}, nil
}

var agentTestWorkspaceID = uuid.MustParse("10000000-0000-4000-8000-000000000001")

type agentAuthorizer struct{}

func (agentAuthorizer) AuthorizeWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Role, error) {
	return identity.RoleOwner, nil
}

func (agentAuthorizer) AuthorizeAgent(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{
		WorkspaceID: agentTestWorkspaceID,
		Role:        identity.RoleOwner,
	}, nil
}

type agentRuntime struct {
	summaries []openfang.AgentSummary
	lists     atomic.Int32
	details   atomic.Int32
}

func (runtime *agentRuntime) ListAgents(context.Context) ([]openfang.AgentSummary, error) {
	runtime.lists.Add(1)
	return runtime.summaries, nil
}

func (runtime *agentRuntime) GetAgent(
	context.Context,
	uuid.UUID,
) (openfang.AgentDetail, error) {
	runtime.details.Add(1)
	return openfang.AgentDetail{}, nil
}

func (*agentRuntime) DispatchMessage(
	context.Context,
	uuid.UUID,
	openfang.MessageRequest,
) (openfang.EventStream, error) {
	return nil, nil
}

func (*agentRuntime) StopAgent(
	context.Context,
	uuid.UUID,
) (openfang.StopResponse, error) {
	return openfang.StopResponse{}, nil
}

type agentStore struct {
	updates []SummaryUpdate
	agent   Agent
}

func (store *agentStore) SyncSummaries(
	_ context.Context,
	_ uuid.UUID,
	updates []SummaryUpdate,
	now time.Time,
) error {
	store.updates = append([]SummaryUpdate(nil), updates...)
	if len(updates) > 0 {
		update := updates[0]
		store.agent = Agent{
			ID:              update.ID,
			OpenFangAgentID: update.OpenFangAgentID,
			Name:            update.Name,
			AvatarURL:       update.AvatarURL,
			Status:          update.Status,
			Capabilities:    []string{},
			CreatedAt:       update.CreatedAt,
			UpdatedAt:       now,
		}
	}
	return nil
}

func (store *agentStore) List(
	context.Context,
	uuid.UUID,
	string,
	*Cursor,
	int,
) ([]Agent, error) {
	if store.agent.ID == uuid.Nil {
		return []Agent{}, nil
	}
	return []Agent{store.agent}, nil
}

func (store *agentStore) Get(context.Context, uuid.UUID, uuid.UUID) (Agent, error) {
	return store.agent, nil
}

func (store *agentStore) UpdateDetail(
	context.Context,
	DetailUpdate,
	uuid.UUID,
	time.Time,
) (Agent, error) {
	return store.agent, nil
}

func (store *agentStore) MarkOffline(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	time.Time,
) (Agent, error) {
	return store.agent, nil
}

func agentTestToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}
