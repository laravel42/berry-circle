package automations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

const draftDefinition = `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},
"steps":[{"id":"notify","type":"create_issue","title":"Thank {{ trigger.issue.identifier }}"}],"entry":["notify"]}`

func registry(t *testing.T) *integrationcore.Registry {
	t.Helper()
	registry := integrationcore.NewRegistry()
	for _, provider := range append(providers.All(), providers.Berry{}) {
		registry.MustRegister(provider)
	}
	return registry
}

// The activation rule: missing connections are named, a high-risk workflow
// needs settings.write, an engine-backed workflow needs the engine, and a
// clean Berry-only workflow activates.
func TestActivateAppliesConnectionRiskAndEngineRules(t *testing.T) {
	catalog := integrationcore.NewCatalog(registry(t), nil)
	slackDefinition := `{"version":"1","trigger":{"id":"t","type":"manual"},
	  "steps":[{"id":"post","type":"action","provider":"slack","operation":"post_message","input":{"channel":"#x"}}],"entry":["post"]}`
	parse := func(text string) automation.Definition {
		definition, findings := automation.ParseDefinition([]byte(text))
		if len(findings) > 0 {
			t.Fatalf("definition: %+v", findings)
		}
		return definition
	}
	store := &fakeStore{}
	base := func(text string, risk automation.Risk, engine automationrepo.Engine) automationrepo.Automation {
		encoded, _ := json.Marshal(parse(text))
		return automationrepo.Automation{ID: uuid.New(), WorkspaceID: uuid.New(), Status: automationrepo.StatusDraft, Definition: encoded, Risk: risk, Engine: engine}
	}
	params := func(item automationrepo.Automation, role identity.Role) ActivationParams {
		return ActivationParams{Automation: item, Role: role, ActorID: uuid.New(), Catalog: catalog, Now: time.Now(), NewID: uuid.New}
	}
	var missing *ConnectionsMissingError
	if _, _, err := Activate(context.Background(), store, params(base(slackDefinition, automation.RiskMedium, automationrepo.EngineNative), identity.RoleAdmin)); !errors.As(err, &missing) || missing.Providers[0] != "slack" {
		t.Fatalf("slack without connection = %v", err)
	}
	if _, _, err := Activate(context.Background(), store, params(base(draftDefinition, automation.RiskHigh, automationrepo.EngineNative), identity.RoleMember)); !errors.Is(err, ErrHighRisk) {
		t.Fatalf("member activating high risk = %v", err)
	}
	if _, _, err := Activate(context.Background(), store, params(base(draftDefinition, automation.RiskLow, automationrepo.EngineActivepieces), identity.RoleAdmin)); !errors.Is(err, automation.ErrEngineDisabled) {
		t.Fatalf("engine workflow without engine = %v", err)
	}
	activated, events, err := Activate(context.Background(), store, params(base(draftDefinition, automation.RiskHigh, automationrepo.EngineNative), identity.RoleAdmin))
	if err != nil || activated.Status != automationrepo.StatusActive || len(events) != 1 || store.status != automationrepo.StatusActive {
		t.Fatalf("clean activation = %+v, %v, %v", activated, events, err)
	}
}

// The mount refuses a malformed definition with JSON-pointer paths under
// /definition, hides cross-workspace workflows, and maps a stale revision.
func TestWorkflowRoutesValidateDefinitionsAndMapConflicts(t *testing.T) {
	store := &fakeStore{}
	mount := newTestMount(t, store, identity.RoleMember, nil)
	workspaceID := uuid.New()
	bad := `{"workspaceId":"` + workspaceID.String() + `","name":"x","definition":{"version":"1","trigger":{"id":"t","type":"berry_event","event":"nope.event"},"steps":[],"entry":[]}}`
	response := do(mount, http.MethodPost, "/", bad)
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "DEFINITION_INVALID") ||
		!strings.Contains(response.Body.String(), `"/definition/trigger/event"`) || !strings.Contains(response.Body.String(), "BERRY_EVENT_UNKNOWN") {
		t.Fatalf("invalid definition = %d %s", response.Code, response.Body.String())
	}
	good := `{"workspaceId":"` + workspaceID.String() + `","name":"Thank donors","definition":` + draftDefinition + `}`
	response = do(mount, http.MethodPost, "/", good)
	if response.Code != http.StatusCreated || store.created == nil || store.created.Trigger.Event != "issue.completed" ||
		!strings.Contains(response.Body.String(), `"status":"draft"`) || !strings.Contains(response.Body.String(), `"requiredConnections":[]`) {
		t.Fatalf("create = %d %s", response.Code, response.Body.String())
	}
	store.updateErr = automationrepo.ErrRevisionConflict
	response = do(mount, http.MethodPatch, "/"+store.created.ID.String(), `{"name":"Renamed","revision":1}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "REVISION_CONFLICT") {
		t.Fatalf("stale patch = %d %s", response.Code, response.Body.String())
	}
	store.updateErr = automationrepo.ErrActive
	response = do(mount, http.MethodPatch, "/"+store.created.ID.String(), `{"definition":`+draftDefinition+`,"revision":1}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "WORKFLOW_ACTIVE") {
		t.Fatalf("active patch = %d %s", response.Code, response.Body.String())
	}
	hidden := newTestMount(t, store, identity.RoleMember, identity.ErrNotFound)
	if response := do(hidden, http.MethodGet, "/"+store.created.ID.String(), ""); response.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace read = %d", response.Code)
	}
	if response := do(mount, http.MethodPost, "/"+store.created.ID.String()+"/webhook", ""); response.Code != http.StatusForbidden {
		t.Fatalf("member rotating a webhook = %d, want 403", response.Code)
	}
}

type fakeStore struct {
	created   *automationrepo.Automation
	status    automationrepo.Status
	updateErr error
}

func (store *fakeStore) List(context.Context, uuid.UUID, automationrepo.ListFilter, *automationrepo.Cursor, int) ([]automationrepo.Automation, error) {
	return nil, nil
}
func (store *fakeStore) Get(context.Context, uuid.UUID) (automationrepo.Automation, error) {
	if store.created == nil {
		return automationrepo.Automation{}, automationrepo.ErrNotFound
	}
	return *store.created, nil
}
func (store *fakeStore) Create(_ context.Context, params automationrepo.CreateParams) (automationrepo.Automation, automationrepo.Event, error) {
	encoded, _ := json.Marshal(params.Definition)
	metadata := automation.DeriveMetadata(params.Definition, params.Catalog)
	item := automationrepo.Automation{
		ID: params.ID, WorkspaceID: params.WorkspaceID, Name: params.Name, Status: automationrepo.StatusDraft, Version: 1, Revision: 1,
		Definition: encoded, Layout: json.RawMessage(`{}`), Engine: params.Engine, Risk: metadata.Risk,
		Trigger:   automationrepo.Trigger{Type: metadata.TriggerType, Event: metadata.TriggerEvent},
		CreatedAt: params.CreatedAt, UpdatedAt: params.CreatedAt,
	}
	store.created = &item
	return item, automationrepo.Event{}, nil
}
func (store *fakeStore) Update(context.Context, automationrepo.UpdateParams) (automationrepo.Automation, error) {
	if store.updateErr != nil {
		return automationrepo.Automation{}, store.updateErr
	}
	return *store.created, nil
}
func (store *fakeStore) SetStatus(_ context.Context, id uuid.UUID, to automationrepo.Status, _ uuid.UUID, now time.Time, _ func() uuid.UUID) (automationrepo.Automation, automationrepo.Event, error) {
	store.status = to
	return automationrepo.Automation{ID: id, Status: to, UpdatedAt: now}, automationrepo.Event{ID: uuid.New(), Type: "workflow.activated"}, nil
}
func (store *fakeStore) Archive(context.Context, uuid.UUID, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Automation, automationrepo.Event, error) {
	return automationrepo.Automation{}, automationrepo.Event{}, nil
}
func (store *fakeStore) ListVersions(context.Context, uuid.UUID) ([]automationrepo.Version, error) {
	return nil, nil
}
func (store *fakeStore) RotateWebhookSecret(context.Context, uuid.UUID, string, time.Time) error {
	return nil
}
func (store *fakeStore) ListRuns(context.Context, automationrepo.RunListFilter, *automationrepo.RunCursor, int) ([]automationrepo.Run, error) {
	return nil, nil
}
func (store *fakeStore) CountRuns(context.Context, uuid.UUID) (automationrepo.RunCounts, error) {
	return automationrepo.RunCounts{}, nil
}

type fakeAuthorizer struct {
	role identity.Role
	err  error
}

func (authorizer fakeAuthorizer) AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error) {
	return authorizer.role, authorizer.err
}
func (authorizer fakeAuthorizer) AuthorizeAutomation(_ context.Context, _, _ uuid.UUID, permission identity.Permission) (identity.Scope, error) {
	if authorizer.err != nil {
		return identity.Scope{}, authorizer.err
	}
	if !authorizer.role.Allows(permission) {
		return identity.Scope{}, identity.ErrForbidden
	}
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, nil
}

type sessions struct{}

func (sessions) ResolveSession(context.Context, string) (auth.User, error) {
	return auth.User{ID: uuid.New(), Role: auth.RoleMember}, nil
}

type memoryIdempotency struct{}

func (memoryIdempotency) Begin(context.Context, httpapi.ActorScope, string, [32]byte, time.Time) (httpapi.IdempotencyResult, error) {
	return httpapi.IdempotencyResult{Decision: httpapi.IdempotencyProceed, ClaimID: uuid.New()}, nil
}
func (memoryIdempotency) Complete(context.Context, uuid.UUID, httpapi.StoredResponse, time.Time) error {
	return nil
}
func (memoryIdempotency) Abandon(context.Context, uuid.UUID) error { return nil }

func newTestMount(t *testing.T, store Store, role identity.Role, authErr error) http.Handler {
	t.Helper()
	mount, err := NewMount(Options{
		Store: store, Registry: registry(t), Sessions: sessions{}, Authorization: fakeAuthorizer{role: role, err: authErr},
		Clock: time.Now, NewID: uuid.New, IdempotencyStore: memoryIdempotency{},
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return mount.Handler
}

func do(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "workflow-test-key-0001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
