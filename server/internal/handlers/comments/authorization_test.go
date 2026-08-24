package comments

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

func TestDirectCommentRoutesHideScopeAndEnforceCommentPermission(t *testing.T) {
	commentID := uuid.New()
	user := auth.User{ID: uuid.New(), Role: auth.RoleMember}
	for _, test := range []struct {
		name       string
		method     string
		err        error
		permission identity.Permission
		status     int
	}{
		{"cross workspace read", http.MethodGet, identity.ErrNotFound, identity.PermissionRead, http.StatusNotFound},
		{"viewer cannot edit", http.MethodPatch, identity.ErrForbidden, identity.PermissionCommentWrite, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			authorizer := &commentAuthorizer{err: test.err}
			var target http.Handler
			if test.method == http.MethodGet {
				target = getHandler(nil, authorizer)
			} else {
				target = updateHandler(nil, Options{Authorization: authorizer})
			}
			request := httptest.NewRequest(test.method, "/"+commentID.String(), nil)
			route := chi.NewRouteContext()
			route.URLParams.Add("commentId", commentID.String())
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

type commentAuthorizer struct {
	err        error
	permission identity.Permission
}

func (authorizer *commentAuthorizer) authorize(
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, authorizer.err
}

func (authorizer *commentAuthorizer) AuthorizeIssue(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *commentAuthorizer) AuthorizeComment(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}
