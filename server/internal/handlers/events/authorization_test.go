package events

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestBoardStreamAuthorizesBeforeReplay(t *testing.T) {
	authorizer := &denyingEventAuthorizer{}
	boardID := uuid.New()
	request := httptest.NewRequest(
		http.MethodGet,
		"/?boardId="+boardID.String(),
		nil,
	)
	request = request.WithContext(auth.WithUser(
		request.Context(),
		auth.User{ID: uuid.New()},
	))
	response := httptest.NewRecorder()

	(&handler{authorization: authorizer}).stream(response, request)

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

type denyingEventAuthorizer struct {
	permission identity.Permission
}

func (authorizer *denyingEventAuthorizer) AuthorizeBoard(
	_ context.Context,
	_, _ uuid.UUID,
	permission identity.Permission,
) (identity.Scope, error) {
	authorizer.permission = permission
	return identity.Scope{}, identity.ErrNotFound
}

func (*denyingEventAuthorizer) AuthorizeWorkspace(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Role, error) {
	return "", identity.ErrNotFound
}
