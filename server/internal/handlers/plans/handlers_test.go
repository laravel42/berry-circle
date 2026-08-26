package plans

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	planrepo "github.com/laravel42/berry-circle/server/internal/repository/plans"
)

const planIR = `{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"Ship"},
"issues":[{"tempId":"i_1","title":"Deploy to production","type":"issue","requiresApproval":true}],"confidence":0.7}`

// A viewer hears PLAN_FORBIDDEN, a member approving a high-risk plan gets a
// pending approval rather than a compile, compile refusals map to their
// codes, and a compiled plan reads with its id map.
func TestPlanRoutesGateApprovalByRiskAndMapCompileErrors(t *testing.T) {
	planID := uuid.New()
	store := &fakeStore{header: planrepo.PlanHeader{
		ID: planID, WorkspaceID: uuid.New(), Status: planrepo.StatusDraft, Source: planrepo.SourceAI, IR: json.RawMessage(planIR),
		ValidationStatus: planrepo.ValidationValid, GenerationStatus: planrepo.GenerationSucceeded, CompileStatus: planrepo.CompileNotStarted,
	}}
	viewer := newTestMount(t, store, identity.RoleViewer)
	if response := do(viewer, http.MethodPost, "/"+planID.String()+"/approve", `{}`); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "PLAN_FORBIDDEN") {
		t.Fatalf("viewer approve = %d %s", response.Code, response.Body.String())
	}
	member := newTestMount(t, store, identity.RoleMember)
	response := do(member, http.MethodGet, "/"+planID.String(), "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"risk":"high"`) || !strings.Contains(response.Body.String(), `"needsAdminActivation":true`) {
		t.Fatalf("member read = %d %s", response.Code, response.Body.String())
	}
	response = do(member, http.MethodPost, "/"+planID.String()+"/approve", `{}`)
	if response.Code != http.StatusAccepted || store.requested != 1 || store.compiled != 0 || !strings.Contains(response.Body.String(), `"status":"pendingApproval"`) {
		t.Fatalf("member approve of high risk = %d %s (requested %d compiled %d)", response.Code, response.Body.String(), store.requested, store.compiled)
	}
	admin := newTestMount(t, store, identity.RoleAdmin)
	store.compileErr = &planrepo.CompileError{Stage: "issues", Message: "workspace has no board"}
	response = do(admin, http.MethodPost, "/"+planID.String()+"/compile", `{}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PLAN_COMPILE_FAILED") || !strings.Contains(response.Body.String(), `"stage":"issues"`) {
		t.Fatalf("compile failure = %d %s", response.Code, response.Body.String())
	}
	store.compileErr = &planrepo.InvalidPlanError{Findings: []ir.Finding{{Path: "/issues/0/title", Code: "STEP_FIELD_REQUIRED"}}}
	response = do(admin, http.MethodPost, "/"+planID.String()+"/approve", `{}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "PLAN_INVALID") || !strings.Contains(response.Body.String(), "STEP_FIELD_REQUIRED") {
		t.Fatalf("invalid plan = %d %s", response.Code, response.Body.String())
	}
	store.compileErr = nil
	response = do(admin, http.MethodPost, "/"+planID.String()+"/approve", `{}`)
	if response.Code != http.StatusOK || store.compiled != 1 || !strings.Contains(response.Body.String(), `"compile":{"status":"succeeded"`) ||
		!strings.Contains(response.Body.String(), `"issueIds":["`) {
		t.Fatalf("admin approve = %d %s", response.Code, response.Body.String())
	}
}

type fakeStore struct {
	header     planrepo.PlanHeader
	requested  int
	compiled   int
	compileErr error
}

func (store *fakeStore) GetHeader(context.Context, uuid.UUID) (planrepo.PlanHeader, error) {
	return store.header, nil
}
func (store *fakeStore) ListVersions(context.Context, uuid.UUID) ([]planrepo.PlanVersion, error) {
	return nil, nil
}
func (store *fakeStore) ListEvents(context.Context, uuid.UUID) ([]planrepo.PlannerEvent, error) {
	return nil, nil
}
func (store *fakeStore) SetValidation(_ context.Context, _ uuid.UUID, status string, _ time.Time) error {
	store.header.ValidationStatus = status
	return nil
}
func (store *fakeStore) Compile(_ context.Context, params planrepo.CompileParams) (planrepo.CompileResult, error) {
	if store.compileErr != nil {
		return planrepo.CompileResult{}, store.compileErr
	}
	store.compiled++
	plan, _ := ir.Parse(store.header.IR)
	issueID := uuid.New()
	plan.Compiled = &ir.Compiled{GoalID: uuid.New(), IssueIDs: map[string]uuid.UUID{"i_1": issueID}, WorkflowIDs: map[string]uuid.UUID{}, ApprovalIDs: map[string]uuid.UUID{}}
	encoded, _ := json.Marshal(plan)
	compiledAt := params.Now
	store.header.Status = planrepo.StatusApproved
	store.header.CompileStatus = planrepo.CompileSucceeded
	store.header.CompiledAt = &compiledAt
	store.header.IR = encoded
	return planrepo.CompileResult{Plan: store.header, IR: plan, IssueIDs: plan.Compiled.IssueIDs}, nil
}
func (store *fakeStore) RejectGenerated(context.Context, uuid.UUID, string, time.Time) error {
	return nil
}
func (store *fakeStore) RequestPlanApproval(_ context.Context, params planrepo.RequestPlanApprovalParams) (planrepo.PlanHeader, approvalrepo.Approval, ledger.Event, error) {
	store.requested++
	store.header.Status = planrepo.StatusPendingApproval
	return store.header, approvalrepo.Approval{Kind: approvalrepo.KindPlan, Risk: params.Risk}, ledger.Event{}, nil
}

type fakeAuthorizer struct{ role identity.Role }

func (authorizer fakeAuthorizer) AuthorizePlan(_ context.Context, _, _ uuid.UUID, permission identity.Permission) (identity.Scope, error) {
	if !authorizer.role.Allows(permission) {
		return identity.Scope{}, identity.ErrForbidden
	}
	return identity.Scope{WorkspaceID: uuid.New(), Role: authorizer.role}, nil
}

func (authorizer fakeAuthorizer) AuthorizeWorkspace(_ context.Context, _, _ uuid.UUID, permission identity.Permission) (identity.Role, error) {
	if !authorizer.role.Allows(permission) {
		return authorizer.role, identity.ErrForbidden
	}
	return authorizer.role, nil
}

type sessions struct{}

func (sessions) ResolveSession(context.Context, string) (auth.User, error) {
	workspaceID := uuid.MustParse("99999999-9999-4999-8999-999999999999")
	return auth.User{ID: uuid.New(), Role: auth.RoleMember, CurrentWorkspaceID: &workspaceID}, nil
}

type memoryIdempotency struct{}

func (memoryIdempotency) Begin(context.Context, httpapi.ActorScope, string, [32]byte, time.Time) (httpapi.IdempotencyResult, error) {
	return httpapi.IdempotencyResult{Decision: httpapi.IdempotencyProceed, ClaimID: uuid.New()}, nil
}
func (memoryIdempotency) Complete(context.Context, uuid.UUID, httpapi.StoredResponse, time.Time) error {
	return nil
}
func (memoryIdempotency) Abandon(context.Context, uuid.UUID) error { return nil }

func newTestMount(t *testing.T, store Store, role identity.Role, extra ...func(*Options)) http.Handler {
	t.Helper()
	options := Options{
		Store: store, Sessions: sessions{}, Authorization: fakeAuthorizer{role: role},
		Clock: time.Now, NewID: uuid.New, IdempotencyStore: memoryIdempotency{},
	}
	for _, apply := range extra {
		apply(&options)
	}
	mount, err := NewMount(options)
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	return mount.Handler
}

func do(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "plan-test-key-000001")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
