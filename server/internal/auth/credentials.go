package auth

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// CredentialKind records which bearer lifecycle authenticated a request.
type CredentialKind string

const (
	CredentialSession       CredentialKind = "session"
	CredentialPersonalToken CredentialKind = "personalToken"
)

// Credential is attached to request context without retaining the raw bearer.
type Credential struct {
	Kind    CredentialKind
	TokenID *uuid.UUID
	User    User
}

type credentialContextKey struct{}

// WithCredential attaches authenticated credential metadata and its user.
func WithCredential(ctx context.Context, credential Credential) context.Context {
	ctx = context.WithValue(ctx, credentialContextKey{}, credential)
	return WithUser(ctx, credential.User)
}

// CredentialFromContext returns safe authentication metadata for a request.
func CredentialFromContext(ctx context.Context) (Credential, bool) {
	credential, ok := ctx.Value(credentialContextKey{}).(Credential)
	return credential, ok
}

// CredentialResolver can preserve credential-kind metadata through middleware.
type CredentialResolver interface {
	ResolveCredential(context.Context, string) (Credential, error)
}

// StoredPersonalToken contains the minimum data needed for constant-time
// verification. SecretHash is never serialized or logged.
type StoredPersonalToken struct {
	ID         uuid.UUID
	User       User
	SecretHash [sha256.Size]byte
	ExpiresAt  *time.Time
	RevokedAt  *time.Time
}

// PersonalTokenStore is implemented by the identity repository.
type PersonalTokenStore interface {
	FindPersonalToken(context.Context, string) (StoredPersonalToken, error)
	TouchPersonalToken(context.Context, uuid.UUID, time.Time) error
}

// PersonalTokenResolver verifies Berry PATs without ever loading a raw secret
// from storage.
type PersonalTokenResolver struct {
	store PersonalTokenStore
	now   func() time.Time
}

// NewPersonalTokenResolver validates the hash-only PAT verification boundary.
func NewPersonalTokenResolver(
	store PersonalTokenStore,
	now func() time.Time,
) (*PersonalTokenResolver, error) {
	if store == nil {
		return nil, errors.New("personal token store is nil")
	}
	if now == nil {
		return nil, errors.New("personal token clock is nil")
	}
	return &PersonalTokenResolver{store: store, now: now}, nil
}

// ResolveCredential performs one indexed lookup followed by constant-time hash
// comparison and a synchronous last-used metadata update.
func (resolver *PersonalTokenResolver) ResolveCredential(
	ctx context.Context,
	token string,
) (Credential, error) {
	publicID, secret, err := ParsePersonalToken(token)
	if err != nil {
		return Credential{}, ErrUnauthenticated
	}
	stored, err := resolver.store.FindPersonalToken(ctx, publicID)
	if errors.Is(err, ErrUnauthenticated) {
		return Credential{}, ErrUnauthenticated
	}
	if err != nil {
		return Credential{}, fmt.Errorf("find personal token: %w", err)
	}
	now := resolver.now().UTC()
	if stored.ID == uuid.Nil || stored.RevokedAt != nil ||
		(stored.ExpiresAt != nil && !stored.ExpiresAt.After(now)) {
		return Credential{}, ErrUnauthenticated
	}
	presented := sha256.Sum256([]byte(secret))
	if subtle.ConstantTimeCompare(presented[:], stored.SecretHash[:]) != 1 {
		return Credential{}, ErrUnauthenticated
	}
	if err := resolver.store.TouchPersonalToken(ctx, stored.ID, now); err != nil {
		return Credential{}, fmt.Errorf("touch personal token: %w", err)
	}
	tokenID := stored.ID
	return Credential{
		Kind:    CredentialPersonalToken,
		TokenID: &tokenID,
		User:    stored.User,
	}, nil
}

// CompositeResolver preserves the SessionResolver interface consumed by
// existing handlers while adding strict personal-token dispatch.
type CompositeResolver struct {
	Sessions SessionResolver
	Personal CredentialResolver
}

// ResolveCredential chooses a verifier by the credential's reserved prefix.
func (resolver CompositeResolver) ResolveCredential(
	ctx context.Context,
	token string,
) (Credential, error) {
	if IsPersonalToken(token) {
		if resolver.Personal == nil {
			return Credential{}, ErrUnauthenticated
		}
		return resolver.Personal.ResolveCredential(ctx, token)
	}
	if resolver.Sessions == nil {
		return Credential{}, ErrUnauthenticated
	}
	if detailed, ok := resolver.Sessions.(CredentialResolver); ok {
		return detailed.ResolveCredential(ctx, token)
	}
	user, err := resolver.Sessions.ResolveSession(ctx, token)
	if err != nil {
		return Credential{}, err
	}
	return Credential{Kind: CredentialSession, User: user}, nil
}

// ResolveSession is the compatibility method used by existing mount options.
func (resolver CompositeResolver) ResolveSession(
	ctx context.Context,
	token string,
) (User, error) {
	credential, err := resolver.ResolveCredential(ctx, token)
	if err != nil {
		return User{}, err
	}
	return credential.User, nil
}
