package agents

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestAgentGetHidesCrossWorkspaceResource(t *testing.T) {
	agentID := uuid.New()
	authorizer := &denyingAgentAuthorizer{}
	request := httptest.NewRequest(http.MethodGet, "/"+agentID.String(), nil)
	route := chi.NewRouteContext()
	route.URLParams.Add("agentId", agentID.String())
	ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
	request = request.WithContext(auth.WithUser(ctx, auth.User{ID: uuid.New()}))
	response := httptest.NewRecorder()

	getHandler(nil, Options{Authorization: authorizer}).ServeHTTP(response, request)

	if response.Code != http.StatusNotFound ||
		authorizer.permission != identity.PermissionRead {
		t.Fatalf(
			"status=%d permission=%q, want 404 %q",
			response.Code,
			authorizer.permission,
			identity.PermissionRead,
		)
	}
}

type denyingAgentAuthorizer struct {
	permission identity.Permission
}

func (*denyingAgentAuthorizer) AuthorizeWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Role, error) {
	return "", identity.ErrNotFound
}

func (authorizer *denyingAgentAuthorizer) AuthorizeAgent(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, identity.ErrNotFound
}
