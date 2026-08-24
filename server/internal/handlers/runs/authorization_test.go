package runs

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

func TestDirectRunRoutesHideScopeAndEnforceDispatchPermission(t *testing.T) {
	runID := uuid.New()
	user := auth.User{ID: uuid.New(), Role: auth.RoleMember}
	for _, test := range []struct {
		name       string
		method     string
		err        error
		permission identity.Permission
		status     int
	}{
		{"cross workspace read", http.MethodGet, identity.ErrNotFound, identity.PermissionRead, http.StatusNotFound},
		{"viewer cannot cancel", http.MethodPost, identity.ErrForbidden, identity.PermissionRunsDispatch, http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			authorizer := &denyingRunAuthorizer{err: test.err}
			handlers := &Handlers{authorization: authorizer}
			request := httptest.NewRequest(test.method, "/"+runID.String(), nil)
			route := chi.NewRouteContext()
			route.URLParams.Add("runId", runID.String())
			ctx := context.WithValue(request.Context(), chi.RouteCtxKey, route)
			request = request.WithContext(auth.WithUser(ctx, user))
			response := httptest.NewRecorder()

			if test.method == http.MethodGet {
				handlers.get(response, request)
			} else {
				handlers.cancel(response, request)
			}

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

type denyingRunAuthorizer struct {
	err        error
	permission identity.Permission
}

func (authorizer *denyingRunAuthorizer) authorize(
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, authorizer.err
}

func (authorizer *denyingRunAuthorizer) AuthorizeIssue(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *denyingRunAuthorizer) AuthorizeBoard(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *denyingRunAuthorizer) AuthorizeRun(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *denyingRunAuthorizer) AuthorizeAgent(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}
