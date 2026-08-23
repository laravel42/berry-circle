package projects

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
	projectrepo "github.com/laravel42/berry-circle/server/internal/repository/projects"
)

func TestProjectHTTPListUsesCamelCaseConnection(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 17, 0, 0, 0, time.UTC)
	userID, workspaceID, projectID := uuid.New(), uuid.New(), uuid.New()
	api := &projectAPIStub{projects: []projectrepo.Project{{
		ID:          projectID,
		WorkspaceID: workspaceID,
		Name:        "First P2 lane",
		Status:      projectrepo.StatusActive,
		Priority:    projectrepo.PriorityHigh,
		CreatedAt:   now,
		UpdatedAt:   now,
	}}}
	handler := projectTestHandler(t, api, auth.User{ID: userID}, now)
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/v1/projects?workspaceId="+workspaceID.String()+"&first=1",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+projectTestToken())
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	body := response.Body.String()
	for _, required := range []string{`"workspaceId"`, `"pageInfo"`, `"hasNextPage"`} {
		if !strings.Contains(body, required) {
			t.Fatalf("response is missing %s: %s", required, body)
		}
	}
	if strings.Contains(body, "workspace_id") {
		t.Fatalf("response leaked storage naming: %s", body)
	}
}

func TestProjectCreateRejectsUnknownFieldsBeforeService(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 17, 0, 0, 0, time.UTC)
	workspaceID := uuid.New()
	api := &projectAPIStub{}
	handler := projectTestHandler(t, api, auth.User{ID: uuid.New()}, now)
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects",
		strings.NewReader(
			`{"workspaceId":"`+workspaceID.String()+`","name":"P2","forgedRole":"owner"}`,
		),
	)
	request.Header.Set("Authorization", "Bearer "+projectTestToken())
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", "project-create-test-key")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if api.createCalled {
		t.Fatal("strict JSON failure reached project service")
	}
}

func TestProjectResourceRejectsUnsafeURL(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/projects/"+uuid.NewString()+"/resources",
		strings.NewReader(`{"kind":"link","url":"javascript:alert(1)"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()

	if _, ok := parseCreateResource(response, request); ok {
		t.Fatal("unsafe URL was accepted")
	}
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
}

type projectAPIStub struct {
	API
	projects     []projectrepo.Project
	createCalled bool
}

func (api *projectAPIStub) List(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	projectrepo.ListFilter,
	*projectrepo.Cursor,
	int,
) ([]projectrepo.Project, error) {
	return api.projects, nil
}

func (api *projectAPIStub) Create(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	projectrepo.CreateParams,
) (projectrepo.Project, error) {
	api.createCalled = true
	return projectrepo.Project{}, nil
}

func projectTestHandler(
	t *testing.T,
	api API,
	user auth.User,
	now time.Time,
) http.Handler {
	t.Helper()
	mount, err := NewMount(Options{
		Sessions:         projectSessionResolver{user: user},
		Clock:            func() time.Time { return now },
		IdempotencyStore: &projectIdempotencyStore{},
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

type projectSessionResolver struct {
	user auth.User
}

func (resolver projectSessionResolver) ResolveSession(
	context.Context,
	string,
) (auth.User, error) {
	return resolver.user, nil
}

type projectIdempotencyStore struct{}

func (*projectIdempotencyStore) Begin(
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

func (*projectIdempotencyStore) Complete(
	context.Context,
	uuid.UUID,
	httpapi.StoredResponse,
	time.Time,
) error {
	return nil
}

func (*projectIdempotencyStore) Abandon(context.Context, uuid.UUID) error {
	return nil
}

func projectTestToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}
