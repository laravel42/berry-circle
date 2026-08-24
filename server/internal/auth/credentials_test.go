package auth

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPersonalTokenVerificationStoresNoSecretAndEnforcesLifecycle(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	generated, err := GeneratePersonalToken(bytes.NewReader(bytes.Repeat([]byte{0x31}, 44)))
	if err != nil {
		t.Fatalf("GeneratePersonalToken() error = %v", err)
	}
	if strings.Contains(string(generated.SecretHash[:]), generated.Token) {
		t.Fatal("generated hash contains raw personal token")
	}
	_, secret, err := ParsePersonalToken(generated.Token)
	if err != nil {
		t.Fatalf("ParsePersonalToken() error = %v", err)
	}
	store := &personalStore{
		record: StoredPersonalToken{
			ID:         uuid.MustParse("10000000-0000-4000-8000-000000000001"),
			User:       User{ID: uuid.MustParse("20000000-0000-4000-8000-000000000002")},
			SecretHash: DigestToken(secret),
		},
	}
	resolver, err := NewPersonalTokenResolver(store, func() time.Time { return now })
	if err != nil {
		t.Fatalf("NewPersonalTokenResolver() error = %v", err)
	}
	credential, err := resolver.ResolveCredential(context.Background(), generated.Token)
	if err != nil {
		t.Fatalf("ResolveCredential(valid) error = %v", err)
	}
	if credential.Kind != CredentialPersonalToken || store.touched != now {
		t.Fatalf("credential=%#v touched=%s", credential, store.touched)
	}

	wrong, err := GeneratePersonalToken(bytes.NewReader(bytes.Repeat([]byte{0x42}, 44)))
	if err != nil {
		t.Fatalf("GeneratePersonalToken(wrong) error = %v", err)
	}
	_, wrongSecret, err := ParsePersonalToken(wrong.Token)
	if err != nil {
		t.Fatalf("ParsePersonalToken(wrong) error = %v", err)
	}
	forged := PersonalTokenPrefix + generated.PublicID + "_" + wrongSecret
	if _, err := resolver.ResolveCredential(context.Background(), forged); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveCredential(forged) error = %v, want ErrUnauthenticated", err)
	}

	expired := now
	store.record.ExpiresAt = &expired
	if _, err := resolver.ResolveCredential(context.Background(), generated.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveCredential(expired) error = %v, want ErrUnauthenticated", err)
	}
	store.record.ExpiresAt = nil
	revoked := now.Add(-time.Minute)
	store.record.RevokedAt = &revoked
	if _, err := resolver.ResolveCredential(context.Background(), generated.Token); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveCredential(revoked) error = %v, want ErrUnauthenticated", err)
	}
}

func TestCompositeResolverNeverFallsBackReservedPersonalPrefix(t *testing.T) {
	t.Parallel()
	sessions := &countingSessionResolver{}
	resolver := CompositeResolver{Sessions: sessions}
	if _, err := resolver.ResolveCredential(
		context.Background(),
		PersonalTokenPrefix+"malformed",
	); !errors.Is(err, ErrUnauthenticated) {
		t.Fatalf("ResolveCredential() error = %v, want ErrUnauthenticated", err)
	}
	if sessions.calls != 0 {
		t.Fatalf("session resolver calls = %d, want 0", sessions.calls)
	}
}

type personalStore struct {
	record  StoredPersonalToken
	touched time.Time
}

func (store *personalStore) FindPersonalToken(
	context.Context,
	string,
) (StoredPersonalToken, error) {
	return store.record, nil
}

func (store *personalStore) TouchPersonalToken(
	_ context.Context,
	_ uuid.UUID,
	at time.Time,
) error {
	store.touched = at
	return nil
}

type countingSessionResolver struct {
	calls int
}

func (resolver *countingSessionResolver) ResolveSession(
	context.Context,
	string,
) (User, error) {
	resolver.calls++
	return User{}, ErrUnauthenticated
}
