package goals

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
)

// A viewer cannot create, a goal elsewhere reads as not found, blocked cannot
// be requested, and a refused lifecycle move names both ends.
func TestGoalRoutesEnforceScopeAndLifecycle(t *testing.T) {
	store := &fakeStore{}
	viewer := newTestMount(t, store, identity.RoleViewer, nil)
	body := `{"workspaceId":"` + uuid.NewString() + `","title":"Launch"}`
	if response := do(viewer, http.MethodPost, "/", body); response.Code != http.StatusForbidden {
		t.Fatalf("viewer create = %d", response.Code)
	}
	member := newTestMount(t, store, identity.RoleMember, nil)
	response := do(member, http.MethodPost, "/", body)
	if response.Code != http.StatusCreated || store.goal == nil || !strings.Contains(response.Body.String(), `"status":"draft"`) {
		t.Fatalf("create = %d %s", response.Code, response.Body.String())
	}
	path := "/" + store.goal.ID.String()
	if response := do(member, http.MethodPatch, path, `{"status":"blocked"}`); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("blocked request = %d %s", response.Code, response.Body.String())
	}
	store.transitionErr = &goalrepo.TransitionError{From: goalrepo.StatusDraft, To: goalrepo.StatusCompleted}
	response = do(member, http.MethodPatch, path, `{"status":"completed"}`)
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "GOAL_TRANSITION_INVALID") || !strings.Contains(response.Body.String(), `"from":"draft"`) {
		t.Fatalf("invalid transition = %d %s", response.Code, response.Body.String())
	}
	if response := do(member, http.MethodDelete, path, ""); response.Code != http.StatusForbidden {
		t.Fatalf("member delete = %d, want 403 (settings.write)", response.Code)
	}
	hidden := newTestMount(t, store, identity.RoleMember, identity.ErrNotFound)
	if response := do(hidden, http.MethodGet, path, ""); response.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace read = %d", response.Code)
	}
	response = do(member, http.MethodGet, path, "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"progress":{"issuesTotal":2`) {
		t.Fatalf("read = %d %s", response.Code, response.Body.String())
	}
}

type fakeStore struct {
	goal          *goalrepo.Goal
	transitionErr error
}

func (store *fakeStore) List(context.Context, uuid.UUID, goalrepo.ListFilter, *goalrepo.Cursor, int) ([]goalrepo.Goal, error) {
	return nil, nil
}
func (store *fakeStore) Get(context.Context, uuid.UUID) (goalrepo.Goal, error) {
	if store.goal == nil {
		return goalrepo.Goal{}, goalrepo.ErrNotFound
	}
	return *store.goal, nil
}
func (store *fakeStore) Create(_ context.Context, params goalrepo.CreateParams) (goalrepo.Goal, goalrepo.Event, error) {
	goal := goalrepo.Goal{ID: params.ID, WorkspaceID: params.WorkspaceID, Title: params.Title, Status: params.Status, Source: params.Source, CreatedAt: params.CreatedAt, UpdatedAt: params.CreatedAt}
	store.goal = &goal
	return goal, goalrepo.Event{}, nil
}
func (store *fakeStore) Update(context.Context, uuid.UUID, goalrepo.Patch, uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Goal, goalrepo.Event, error) {
	return *store.goal, goalrepo.Event{}, nil
}
func (store *fakeStore) Transition(context.Context, uuid.UUID, goalrepo.Status, *uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Goal, goalrepo.Event, error) {
	if store.transitionErr != nil {
		return goalrepo.Goal{}, goalrepo.Event{}, store.transitionErr
	}
	return *store.goal, goalrepo.Event{}, nil
}
func (store *fakeStore) Archive(context.Context, uuid.UUID, uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Event, error) {
	return goalrepo.Event{}, nil
}
func (store *fakeStore) LinkIssue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error {
	return nil
}
func (store *fakeStore) UnlinkIssue(context.Context, uuid.UUID, uuid.UUID) error { return nil }
func (store *fakeStore) ListIssues(context.Context, uuid.UUID, int) ([]goalrepo.LinkedIssue, error) {
	return nil, nil
}
func (store *fakeStore) Progress(context.Context, uuid.UUID) (goalrepo.Progress, error) {
	return goalrepo.Progress{IssuesTotal: 2, IssuesDone: 1}, nil
}

type fakeAuthorizer struct {
	role identity.Role
	err  error
}

func (authorizer fakeAuthorizer) permit(permission identity.Permission) error {
	if authorizer.err != nil {
		return authorizer.err
	}
	if !authorizer.role.Allows(permission) {
		return identity.ErrForbidden
	}
	return nil
}
func (authorizer fakeAuthorizer) AuthorizeWorkspace(_ context.Context, _, _ uuid.UUID, permission identity.Permission) (identity.Role, error) {
	return authorizer.role, authorizer.permit(permission)
}
func (authorizer fakeAuthorizer) AuthorizeGoal(_ context.Context, _, _ uuid.UUID, permission identity.Permission) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, authorizer.permit(permission)
}
func (authorizer fakeAuthorizer) AuthorizeIssueReference(_ context.Context, _ uuid.UUID, _ string, permission identity.Permission) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, authorizer.permit(permission)
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
		Store: store, Sessions: sessions{}, Authorization: fakeAuthorizer{role: role, err: authErr},
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
	request.Header.Set("Idempotency-Key", "goal-test-key-00001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
