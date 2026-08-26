package approvals

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
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

// The resolution rule (D7): the addressee or a strong enough role may
// resolve, and high risk needs settings.write on top.
func TestMayResolveAppliesAddresseeRoleAndRiskRules(t *testing.T) {
	me, other := uuid.New(), uuid.New()
	cases := []struct {
		name     string
		approval approvalrepo.Approval
		role     identity.Role
		want     string
		allowed  bool
	}{
		{"addressee", approvalrepo.Approval{RequestedFromUserID: &me}, identity.RoleMember, "", true},
		{"someone else", approvalrepo.Approval{RequestedFromUserID: &other}, identity.RoleOwner, "not_addressee", false},
		{"role satisfied by stronger", approvalrepo.Approval{RequestedFromRole: "member"}, identity.RoleAdmin, "", true},
		{"role not satisfied", approvalrepo.Approval{RequestedFromRole: "admin"}, identity.RoleMember, "not_addressee", false},
		{"high risk needs admin", approvalrepo.Approval{RequestedFromRole: "member", Risk: approvalrepo.RiskHigh}, identity.RoleMember, "admin_required", false},
		{"high risk admin", approvalrepo.Approval{RequestedFromRole: "member", Risk: approvalrepo.RiskHigh}, identity.RoleAdmin, "", true},
	}
	for _, testCase := range cases {
		reason, allowed := MayResolve(testCase.approval, me, testCase.role)
		if allowed != testCase.allowed || reason != testCase.want {
			t.Errorf("%s: MayResolve = %q, %v; want %q, %v", testCase.name, reason, allowed, testCase.want, testCase.allowed)
		}
	}
}

// The mount hides cross-workspace approvals, refuses a stranger's decision
// with the reason, and maps a second decision to APPROVAL_RESOLVED.
func TestApprovalRoutesHideScopeAndMapDecisions(t *testing.T) {
	approvalID := uuid.New()
	store := &fakeStore{approval: approvalrepo.Approval{
		ID: approvalID, Kind: approvalrepo.KindIssueStart, Risk: approvalrepo.RiskMedium, Title: "Start", RequestedFromRole: "admin",
		Status: approvalrepo.StatusPending, RequestedAt: time.Now(),
	}}
	mount := newTestMount(t, store, identity.RoleMember, nil)

	response := do(mount, http.MethodPost, "/"+approvalID.String()+"/approve", `{}`)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"reason":"not_addressee"`) {
		t.Fatalf("member approving an admin gate = %d %s", response.Code, response.Body.String())
	}
	admin := newTestMount(t, store, identity.RoleAdmin, nil)
	response = do(admin, http.MethodPost, "/"+approvalID.String()+"/approve", `{"note":"ok"}`)
	if response.Code != http.StatusOK || store.resolved != 1 || !strings.Contains(response.Body.String(), `"kind":"issueStart"`) {
		t.Fatalf("admin approve = %d %s (resolved %d)", response.Code, response.Body.String(), store.resolved)
	}
	store.resolveErr = approvalrepo.ErrAlreadyResolved
	response = do(admin, http.MethodPost, "/"+approvalID.String()+"/approve", `{}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "APPROVAL_RESOLVED") {
		t.Fatalf("second approve = %d %s", response.Code, response.Body.String())
	}
	hidden := newTestMount(t, store, identity.RoleAdmin, identity.ErrNotFound)
	response = do(hidden, http.MethodGet, "/"+approvalID.String(), "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-workspace read = %d, want 404", response.Code)
	}
	response = do(admin, http.MethodPost, "/", `{"workspaceId":"not-a-uuid","kind":"plan","issueId":"x","title":""}`)
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "/kind") {
		t.Fatalf("invalid create = %d %s", response.Code, response.Body.String())
	}
}

type fakeStore struct {
	approval   approvalrepo.Approval
	resolved   int
	resolveErr error
}

func (store *fakeStore) List(context.Context, uuid.UUID, approvalrepo.ListFilter, *approvalrepo.Cursor, int) ([]approvalrepo.Approval, error) {
	return []approvalrepo.Approval{store.approval}, nil
}
func (store *fakeStore) PendingFor(context.Context, uuid.UUID, uuid.UUID, identity.Role, int) ([]approvalrepo.Approval, error) {
	return nil, nil
}
func (store *fakeStore) Get(context.Context, uuid.UUID) (approvalrepo.Approval, error) {
	return store.approval, nil
}
func (store *fakeStore) Create(_ context.Context, params approvalrepo.CreateParams) (approvalrepo.Approval, approvalrepo.Event, error) {
	return approvalrepo.Approval{ID: params.ID, Kind: params.Kind, Status: approvalrepo.StatusPending, Title: params.Title, RequestedAt: params.RequestedAt}, approvalrepo.Event{}, nil
}
func (store *fakeStore) Resolve(_ context.Context, _ uuid.UUID, resolution approvalrepo.Resolution) (approvalrepo.Approval, []approvalrepo.Event, error) {
	if store.resolveErr != nil {
		return approvalrepo.Approval{}, nil, store.resolveErr
	}
	store.resolved++
	resolved := store.approval
	resolved.Status = approvalrepo.Status(resolution.Decision)
	return resolved, nil, nil
}

type fakeAuthorizer struct {
	role identity.Role
	err  error
}

func (authorizer fakeAuthorizer) AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error) {
	return authorizer.role, authorizer.err
}
func (authorizer fakeAuthorizer) AuthorizeApproval(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, authorizer.err
}
func (authorizer fakeAuthorizer) AuthorizeIssue(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, authorizer.err
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
	request.Header.Set("Idempotency-Key", "approval-test-key-0001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
