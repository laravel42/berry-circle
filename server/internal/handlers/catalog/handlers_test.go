package catalog

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	catalogrepo "github.com/laravel42/berry-circle/server/internal/repository/catalogs"
)

func TestQuickActionHTTPNeverReturnsHiddenPrompt(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 17, 30, 0, 0, time.UTC)
	userID, workspaceID, actionID, issueID, agentID := fiveIDs()
	api := &catalogAPIStub{action: catalogrepo.QuickAction{
		ID:            actionID,
		WorkspaceID:   workspaceID,
		Name:          "Review",
		TargetAgentID: agentID,
		Visibility:    catalogrepo.QuickActionWorkspace,
		CreatedBy:     userID,
		CreatedAt:     now,
		UpdatedAt:     now,
	}}
	handler := catalogTestHandler(t, api, auth.User{ID: userID}, now)

	get := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/catalogs/"+workspaceID.String()+"/quick-actions/"+actionID.String(),
		nil,
	)
	get.Header.Set("Authorization", "Bearer "+catalogTestToken())
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("get status=%d body=%s", getResponse.Code, getResponse.Body)
	}
	if strings.Contains(strings.ToLower(getResponse.Body.String()), "prompt") {
		t.Fatalf("get response exposed a prompt field: %s", getResponse.Body)
	}

	render := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/catalogs/"+workspaceID.String()+"/quick-actions/"+
			actionID.String()+"/render",
		strings.NewReader(`{"issueId":"`+issueID.String()+`"}`),
	)
	render.Header.Set("Authorization", "Bearer "+catalogTestToken())
	render.Header.Set("Content-Type", "application/json")
	renderResponse := httptest.NewRecorder()
	handler.ServeHTTP(renderResponse, render)
	if renderResponse.Code != http.StatusOK {
		t.Fatalf("render status=%d body=%s", renderResponse.Code, renderResponse.Body)
	}
	body := renderResponse.Body.String()
	if strings.Contains(strings.ToLower(body), "prompt") || !strings.Contains(body, `"ready":false`) {
		t.Fatalf("render response crossed safe boundary: %s", body)
	}
}

func TestQuickActionRunFailsClosedWithoutExecutor(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 17, 30, 0, 0, time.UTC)
	userID, workspaceID, actionID, issueID, agentID := fiveIDs()
	api := &catalogAPIStub{action: catalogrepo.QuickAction{
		ID:            actionID,
		WorkspaceID:   workspaceID,
		Name:          "Review",
		TargetAgentID: agentID,
		Visibility:    catalogrepo.QuickActionWorkspace,
		CreatedBy:     userID,
	}}
	handler := catalogTestHandler(t, api, auth.User{ID: userID}, now)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/catalogs/"+workspaceID.String()+"/quick-actions/"+actionID.String()+"/run",
		strings.NewReader(`{"issueId":"`+issueID.String()+`"}`),
	)
	request.Header.Set("Authorization", "Bearer "+catalogTestToken())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "quick-action-run-test-key")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusNotImplemented {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"code":"CAPABILITY_NOT_IMPLEMENTED"`) ||
		strings.Contains(strings.ToLower(response.Body.String()), "prompt") {
		t.Fatalf("unsafe capability response: %s", response.Body)
	}
}

func TestStatusPatchCannotChangeWorkflowCategory(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 17, 30, 0, 0, time.UTC)
	api := &catalogAPIStub{}
	workspaceID, statusID := uuid.New(), uuid.New()
	handler := catalogTestHandler(t, api, auth.User{ID: uuid.New()}, now)
	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/catalogs/"+workspaceID.String()+"/issue-statuses/"+statusID.String(),
		strings.NewReader(`{"category":"done"}`),
	)
	request.Header.Set("Authorization", "Bearer "+catalogTestToken())
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if api.statusUpdated {
		t.Fatal("category mutation reached catalog service")
	}
}

type catalogAPIStub struct {
	API
	action        catalogrepo.QuickAction
	statusUpdated bool
}

func (api *catalogAPIStub) GetQuickAction(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
) (catalogrepo.QuickAction, error) {
	return api.action, nil
}

func (api *catalogAPIStub) RenderQuickAction(
	_ context.Context,
	_, _ uuid.UUID,
	issueID, _ uuid.UUID,
) (catalogrepo.QuickActionRender, error) {
	return catalogrepo.QuickActionRender{
		ActionID:      api.action.ID,
		IssueID:       issueID,
		Name:          api.action.Name,
		TargetAgentID: api.action.TargetAgentID,
		Ready:         true,
	}, nil
}

func (api *catalogAPIStub) AuthorizeQuickActionRun(
	_ context.Context,
	_, _ uuid.UUID,
	issueID, _ uuid.UUID,
) (catalogrepo.QuickActionRender, error) {
	return catalogrepo.QuickActionRender{
		ActionID:      api.action.ID,
		IssueID:       issueID,
		Name:          api.action.Name,
		TargetAgentID: api.action.TargetAgentID,
		Ready:         true,
	}, nil
}

func (api *catalogAPIStub) UpdateStatus(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	uuid.UUID,
	catalogrepo.StatusPatch,
) (catalogrepo.StatusDefinition, error) {
	api.statusUpdated = true
	return catalogrepo.StatusDefinition{}, nil
}

func catalogTestHandler(
	t *testing.T,
	api API,
	user auth.User,
	now time.Time,
) http.Handler {
	t.Helper()
	mount, err := NewMount(Options{
		Sessions:         catalogSessionResolver{user: user},
		Clock:            func() time.Time { return now },
		IdempotencyStore: &catalogIdempotencyStore{},
		Service:          api,
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	var registry httpapi.Registry
	if err := registry.Register(mount); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	return registry.Handler(httpapi.Options{})
}

type catalogSessionResolver struct {
	user auth.User
}

func (resolver catalogSessionResolver) ResolveSession(
	context.Context,
	string,
) (auth.User, error) {
	return resolver.user, nil
}

type catalogIdempotencyStore struct{}

func (*catalogIdempotencyStore) Begin(
	context.Context,
	httpapi.ActorScope,
	string,
	[sha256.Size]byte,
	time.Time,
) (httpapi.IdempotencyResult, error) {
	return httpapi.IdempotencyResult{
		Decision: httpapi.IdempotencyProceed,
		ClaimID:  uuid.New(),
	}, nil
}

func (*catalogIdempotencyStore) Complete(
	context.Context,
	uuid.UUID,
	httpapi.StoredResponse,
	time.Time,
) error {
	return nil
}

func (*catalogIdempotencyStore) Abandon(context.Context, uuid.UUID) error {
	return nil
}

func fiveIDs() (uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID) {
	return uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
}

func catalogTestToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}
