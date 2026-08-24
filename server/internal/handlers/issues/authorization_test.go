package issues

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestIssueHandlersHideBoardScopeAndEnforceWriteRole(t *testing.T) {
	boardID := uuid.New()
	user := auth.User{ID: uuid.New(), Role: auth.RoleMember}
	tests := []struct {
		name       string
		target     http.Handler
		request    *http.Request
		authorizer *issueAuthorizer
		permission identity.Permission
		status     int
	}{
		{
			name:       "cross workspace list",
			authorizer: &issueAuthorizer{err: identity.ErrNotFound},
			permission: identity.PermissionRead,
			status:     http.StatusNotFound,
		},
		{
			name:       "viewer cannot create",
			authorizer: &issueAuthorizer{err: identity.ErrForbidden},
			permission: identity.PermissionWrite,
			status:     http.StatusForbidden,
		},
	}
	for index := range tests {
		test := &tests[index]
		if index == 0 {
			test.target = listHandler(nil, test.authorizer)
			test.request = httptest.NewRequest(
				http.MethodGet,
				"/?boardId="+boardID.String(),
				nil,
			)
		} else {
			test.target = createHandler(nil, Options{Authorization: test.authorizer})
			test.request = httptest.NewRequest(
				http.MethodPost,
				"/",
				bytes.NewBufferString(
					`{"boardId":"`+boardID.String()+`","title":"Scoped issue"}`,
				),
			)
			test.request.Header.Set("Content-Type", "application/json")
		}
		test.request = test.request.WithContext(
			auth.WithUser(test.request.Context(), user),
		)
		response := httptest.NewRecorder()

		test.target.ServeHTTP(response, test.request)

		if response.Code != test.status ||
			test.authorizer.permission != test.permission {
			t.Fatalf(
				"%s: status=%d permission=%q, want %d %q",
				test.name,
				response.Code,
				test.authorizer.permission,
				test.status,
				test.permission,
			)
		}
	}
}

type issueAuthorizer struct {
	err        error
	permission identity.Permission
}

func (authorizer *issueAuthorizer) authorize(
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, authorizer.err
}

func (authorizer *issueAuthorizer) AuthorizeBoard(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *issueAuthorizer) AuthorizeIssue(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *issueAuthorizer) AuthorizeIssueReference(
	_ context.Context,
	_ uuid.UUID,
	_ string,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (authorizer *issueAuthorizer) AuthorizeComment(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	return authorizer.authorize(permission)
}

func (*issueAuthorizer) ValidateAssignee(
	context.Context,
	uuid.UUID,
	string,
	uuid.UUID,
) error {
	return nil
}
