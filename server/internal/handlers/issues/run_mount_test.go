package issues

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

func TestNewMountOptionallyMountsIssueRunHandlerBehindAuth(t *testing.T) {
	issueID := uuid.New()
	called := false
	runHandler := http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		called = true
		if chi.URLParam(request, "issueRef") != issueID.String() {
			t.Errorf("issueRef = %q", chi.URLParam(request, "issueRef"))
		}
		if _, ok := auth.UserFromContext(request.Context()); !ok {
			t.Error("authenticated user missing from context")
		}
		response.WriteHeader(http.StatusNoContent)
	})
	mount, err := NewMount(Options{
		Pool:             &pgxpool.Pool{},
		Sessions:         runMountSessions{},
		Authorization:    runMountAuthorizer{},
		Clock:            time.Now,
		NewID:            uuid.New,
		IdempotencyStore: runMountIdempotency{},
		RunHandler:       runHandler,
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodGet,
		"/"+issueID.String()+"/runs/",
		nil,
	)
	request.Header.Set("Authorization", "Bearer "+runMountToken())
	response := httptest.NewRecorder()

	mount.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || !called {
		t.Fatalf("status = %d called=%t body=%s", response.Code, called, response.Body.String())
	}
}

type runMountSessions struct{}

func (runMountSessions) ResolveSession(context.Context, string) (auth.User, error) {
	return auth.User{ID: uuid.New(), Role: auth.RoleMember}, nil
}

type runMountAuthorizer struct{}

func (runMountAuthorizer) AuthorizeBoard(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleOwner}, nil
}

func (runMountAuthorizer) AuthorizeIssue(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleOwner}, nil
}

func (runMountAuthorizer) AuthorizeIssueReference(
	context.Context,
	uuid.UUID,
	string,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleOwner}, nil
}

func (runMountAuthorizer) AuthorizeComment(
	context.Context,
	uuid.UUID,
	uuid.UUID,
	identity.Permission,
) (identity.Scope, error) {
	return identity.Scope{WorkspaceID: uuid.New(), Role: identity.RoleOwner}, nil
}

func (runMountAuthorizer) ValidateAssignee(
	context.Context,
	uuid.UUID,
	string,
	uuid.UUID,
) error {
	return nil
}

type runMountIdempotency struct{}

func (runMountIdempotency) Begin(
	context.Context,
	httpapi.ActorScope,
	string,
	[32]byte,
	time.Time,
) (httpapi.IdempotencyResult, error) {
	return httpapi.IdempotencyResult{}, nil
}

func (runMountIdempotency) Complete(
	context.Context,
	uuid.UUID,
	httpapi.StoredResponse,
	time.Time,
) error {
	return nil
}

func (runMountIdempotency) Abandon(context.Context, uuid.UUID) error {
	return nil
}

func runMountToken() string {
	return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
}
