package boards

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

func TestBoardHandlersHideCrossWorkspaceAndEnforceWriteRole(t *testing.T) {
	boardID := uuid.New()
	user := auth.User{ID: uuid.New(), Role: auth.RoleMember}
	for _, test := range []struct {
		name       string
		method     string
		permission identity.Permission
		err        error
		status     int
	}{
		{"read cross workspace", http.MethodGet, identity.PermissionRead, identity.ErrNotFound, http.StatusNotFound},
		{"viewer cannot update", http.MethodPatch, identity.PermissionWrite, identity.ErrForbidden, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			authorizer := &boardAuthorizer{err: test.err}
			var target http.Handler
			if test.method == http.MethodGet {
				target = getHandler(nil, authorizer)
			} else {
				target = updateHandler(nil, Options{Authorization: authorizer})
			}
			request := httptest.NewRequest(test.method, "/"+boardID.String(), nil)
			route := chi.NewRouteContext()
			route.URLParams.Add("boardId", boardID.String())
			ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
			request = request.WithContext(auth.WithUser(ctx, user))
			response := httptest.NewRecorder()

			target.ServeHTTP(response, request)

			if response.Code != test.status || authorizer.permission != test.permission {
				t.Fatalf(
					"status=%d permission=%q, want %d %q",
					response.Code,
					authorizer.permission,
					test.status,
					test.permission,
				)
			}
		})
	}
}

type boardAuthorizer struct {
	err        error
	permission identity.Permission
}

func (*boardAuthorizer) AuthorizeWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Role, error) {
	return identity.RoleViewer, nil
}

func (authorizer *boardAuthorizer) AuthorizeBoard(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, authorizer.err
}
