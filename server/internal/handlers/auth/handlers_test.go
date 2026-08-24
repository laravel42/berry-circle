package authhandler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

func TestKnownEmailLoginIsExplicitlyDisabledInProduction(t *testing.T) {
	t.Parallel()
	manager := &fakeManager{}
	handler := loginHandler(manager, LoginConfig{
		AllowKnownEmail: true,
		Environment:     "production",
	})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/auth/login",
		strings.NewReader(`{"email":"member@berry.test"}`),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || manager.issued {
		t.Fatalf("status=%d issued=%t body=%s", response.Code, manager.issued, response.Body)
	}
	var envelope httpapi.ErrorEnvelope
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error: %v", err)
	}
	if envelope.Error.Code != "PASSWORDLESS_LOGIN_DISABLED" {
		t.Fatalf("code=%s, want PASSWORDLESS_LOGIN_DISABLED", envelope.Error.Code)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("login response is cacheable")
	}
}

func TestLoginRejectsUnknownFields(t *testing.T) {
	t.Parallel()
	handler := loginHandler(&fakeManager{}, LoginConfig{
		AllowKnownEmail: true,
		Environment:     "test",
	})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/auth/login",
		strings.NewReader(`{"email":"member@berry.test","role":"admin"}`),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status=%d want=422 body=%s", response.Code, response.Body)
	}
}

func TestMeUsesCompositeAuthenticatorWithoutChangingSessionManager(t *testing.T) {
	t.Parallel()
	manager := &fakeManager{}
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	user := coreauth.User{
		ID:        uuid.MustParse("10000000-0000-4000-8000-000000000001"),
		Email:     "member@berry.test",
		Name:      "Member",
		Role:      coreauth.RoleMember,
		CreatedAt: now,
		UpdatedAt: now,
	}
	mount, err := NewMount(Options{
		Pool:          &pgxpool.Pool{},
		Sessions:      manager,
		Authenticator: fixedResolver{user: user},
		Clock:         func() time.Time { return now },
		NewID:         uuid.New,
		Login:         LoginConfig{},
	})
	if err != nil {
		t.Fatalf("NewMount() error = %v", err)
	}
	var registry httpapi.Registry
	if err := registry.Register(mount); err != nil {
		t.Fatalf("register mount: %v", err)
	}
	token, err := coreauth.GeneratePersonalToken(
		bytes.NewReader(bytes.Repeat([]byte{0x44}, 44)),
	)
	if err != nil {
		t.Fatalf("GeneratePersonalToken() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	request.Header.Set("Authorization", "Bearer "+token.Token)
	response := httptest.NewRecorder()
	registry.Handler(httpapi.Options{}).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if manager.resolved {
		t.Fatal("session manager resolved a personal token")
	}
}

type fakeManager struct {
	issued   bool
	resolved bool
}

func (manager *fakeManager) IssueKnownEmail(
	context.Context,
	string,
	coreauth.SessionMetadata,
) (coreauth.IssuedSession, error) {
	manager.issued = true
	return coreauth.IssuedSession{}, nil
}

func (manager *fakeManager) ResolveSession(
	context.Context,
	string,
) (coreauth.User, error) {
	manager.resolved = true
	return coreauth.User{}, coreauth.ErrUnauthenticated
}

func (manager *fakeManager) RevokeSession(context.Context, string) error {
	return nil
}

type fixedResolver struct {
	user coreauth.User
}

func (resolver fixedResolver) ResolveSession(
	context.Context,
	string,
) (coreauth.User, error) {
	return resolver.user, nil
}
