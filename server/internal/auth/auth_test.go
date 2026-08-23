package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

func TestTokenGenerationHashAndStrictBearerParsing(t *testing.T) {
	t.Parallel()
	token, err := GenerateToken(bytes.NewReader(bytes.Repeat([]byte{0x7a}, tokenBytes)))
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	if len(token) != 43 {
		t.Fatalf("token length = %d, want 43", len(token))
	}
	if hash := HashToken(token); hash == token || len(hash) != 64 {
		t.Fatalf("HashToken() = %q, want a 64-character non-token hash", hash)
	}
	if parsed, err := ParseAuthorization("Bearer " + token); err != nil || parsed != token {
		t.Fatalf("ParseAuthorization(valid) = %q, %v", parsed, err)
	}
	for _, header := range []string{
		"",
		"Basic " + token,
		"bearer " + token,
		"Bearer  " + token,
		" Bearer " + token,
		"Bearer " + token + " ",
		"Bearer short",
		"Bearer !" + strings.Repeat("a", 42),
	} {
		if _, err := ParseAuthorization(header); !errors.Is(err, ErrUnauthenticated) {
			t.Errorf("ParseAuthorization(%q) error = %v, want ErrUnauthenticated", header, err)
		}
	}
}

func TestServiceStoresOnlyHashAndEnforcesExpiryAndRevocation(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	user := User{
		ID:        uuid.MustParse("10000000-0000-4000-8000-000000000001"),
		Email:     "member@berry.test",
		Name:      "Member",
		Role:      RoleMember,
		CreatedAt: now,
		UpdatedAt: now,
	}
	store := &memoryStore{user: user}
	clock := now
	service, err := NewService(ServiceOptions{
		Store:      store,
		Now:        func() time.Time { return clock },
		NewID:      func() uuid.UUID { return uuid.MustParse("20000000-0000-4000-8000-000000000002") },
		Random:     bytes.NewReader(bytes.Repeat([]byte{0x42}, tokenBytes)),
		SessionTTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}

	issued, err := service.IssueKnownEmail(context.Background(), user.Email, SessionMetadata{})
	if err != nil {
		t.Fatalf("IssueKnownEmail() error = %v", err)
	}
	if store.record.TokenHash == issued.Token || strings.Contains(store.record.TokenHash, issued.Token) {
		t.Fatal("session store received the raw token")
	}
	if store.record.TokenHash != HashToken(issued.Token) {
		t.Fatal("session store did not receive the SHA-256 token hash")
	}
	if _, err := service.ResolveSession(context.Background(), issued.Token); err != nil {
		t.Fatalf("ResolveSession(live) error = %v", err)
	}

	clock = now.Add(2 * time.Hour)
	if _, err := service.ResolveSession(context.Background(), issued.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveSession(expired) error = %v, want ErrUnauthenticated", err)
	}
	clock = now
	if err := service.RevokeSession(context.Background(), issued.Token); err != nil {
		t.Fatalf("RevokeSession() error = %v", err)
	}
	if _, err := service.ResolveSession(context.Background(), issued.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveSession(revoked) error = %v, want ErrUnauthenticated", err)
	}
}

func TestRequireSessionUsesConstantUnauthorizedEnvelope(t *testing.T) {
	t.Parallel()
	token, err := GenerateToken(bytes.NewReader(bytes.Repeat([]byte{0x24}, tokenBytes)))
	if err != nil {
		t.Fatalf("GenerateToken() error = %v", err)
	}
	resolver := resolverFunc(func(context.Context, string) (User, error) {
		return User{}, ErrUnauthenticated
	})
	handler := RequireSession(resolver)(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))

	var baseline httpapi.ErrorEnvelope
	for index, header := range []string{"", "Basic abc", "Bearer short", "Bearer " + token} {
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		if header != "" {
			request.Header.Set("Authorization", header)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("case %d status = %d, want 401", index, response.Code)
		}
		var envelope httpapi.ErrorEnvelope
		if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
			t.Fatalf("decode unauthorized envelope: %v", err)
		}
		if index == 0 {
			baseline = envelope
		} else if envelope != baseline {
			t.Fatalf("case %d envelope = %#v, want constant %#v", index, envelope, baseline)
		}
	}
}

func TestRoleHelpers(t *testing.T) {
	t.Parallel()
	if !(User{Role: RoleAdmin}).IsAdmin() {
		t.Fatal("admin user was not recognized")
	}
	if (User{Role: RoleMember}).IsAdmin() {
		t.Fatal("member user was recognized as admin")
	}
	if !(User{Role: RoleMember}).HasRole(RoleAdmin, RoleMember) {
		t.Fatal("HasRole() rejected an allowed member")
	}
}

type memoryStore struct {
	user    User
	record  SessionRecord
	revoked bool
}

func (store *memoryStore) FindUserByEmail(_ context.Context, email string) (User, error) {
	if !strings.EqualFold(email, store.user.Email) {
		return User{}, ErrInvalidCredentials
	}
	return store.user, nil
}

func (store *memoryStore) InsertSession(_ context.Context, record SessionRecord) error {
	store.record = record
	store.revoked = false
	return nil
}

func (store *memoryStore) ResolveSessionHash(
	_ context.Context,
	hash string,
	now time.Time,
) (User, error) {
	if store.revoked || hash != store.record.TokenHash || !store.record.ExpiresAt.After(now) {
		return User{}, ErrUnauthenticated
	}
	return store.user, nil
}

func (store *memoryStore) DeleteSessionHash(_ context.Context, hash string) error {
	if hash == store.record.TokenHash {
		store.revoked = true
	}
	return nil
}

type resolverFunc func(context.Context, string) (User, error)

func (resolver resolverFunc) ResolveSession(ctx context.Context, token string) (User, error) {
	return resolver(ctx, token)
}
