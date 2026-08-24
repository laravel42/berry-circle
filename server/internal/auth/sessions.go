package auth

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SessionMetadata is non-authoritative audit context captured at login.
type SessionMetadata struct {
	UserAgent *string
	IP        *string
}

// IssuedSession contains the one-time raw token and its public expiry.
type IssuedSession struct {
	Token     string
	ExpiresAt time.Time
	User      User
}

// SessionRecord never contains the raw bearer token.
type SessionRecord struct {
	ID        uuid.UUID
	UserID    uuid.UUID
	TokenHash string
	UserAgent *string
	IP        *string
	ExpiresAt time.Time
	CreatedAt time.Time
}

// Store isolates the current pgx statements for session lifecycle tests.
type Store interface {
	FindUserByEmail(context.Context, string) (User, error)
	InsertSession(context.Context, SessionRecord) error
	ResolveSessionHash(context.Context, string, time.Time) (User, error)
	DeleteSessionHash(context.Context, string) error
}

// Manager is the dependency consumed by auth-aware handlers.
type Manager interface {
	IssueKnownEmail(context.Context, string, SessionMetadata) (IssuedSession, error)
	ResolveSession(context.Context, string) (User, error)
	RevokeSession(context.Context, string) error
}

// ServiceOptions require deterministic time, IDs, randomness, and persistence.
type ServiceOptions struct {
	Pool       *pgxpool.Pool
	Store      Store
	Now        func() time.Time
	NewID      func() uuid.UUID
	Random     io.Reader
	SessionTTL time.Duration
}

// Service implements hash-only opaque session lifecycle.
type Service struct {
	store      Store
	now        func() time.Time
	newID      func() uuid.UUID
	random     io.Reader
	sessionTTL time.Duration
}

// NewService constructs an explicit, global-free session service.
func NewService(options ServiceOptions) (*Service, error) {
	store := options.Store
	if store == nil {
		if options.Pool == nil {
			return nil, errors.New("auth service pool is nil")
		}
		store = PostgresStore{Pool: options.Pool}
	}
	if options.Now == nil {
		return nil, errors.New("auth service clock is nil")
	}
	if options.NewID == nil {
		return nil, errors.New("auth service ID generator is nil")
	}
	if options.Random == nil {
		return nil, errors.New("auth service random source is nil")
	}
	if options.SessionTTL <= 0 {
		return nil, errors.New("auth service session TTL must be positive")
	}
	return &Service{
		store:      store,
		now:        options.Now,
		newID:      options.NewID,
		random:     options.Random,
		sessionTTL: options.SessionTTL,
	}, nil
}

// IssueKnownEmail creates a session for an existing case-insensitive email.
func (service *Service) IssueKnownEmail(
	ctx context.Context,
	email string,
	metadata SessionMetadata,
) (IssuedSession, error) {
	user, err := service.store.FindUserByEmail(ctx, email)
	if errors.Is(err, ErrInvalidCredentials) {
		return IssuedSession{}, ErrInvalidCredentials
	}
	if err != nil {
		return IssuedSession{}, fmt.Errorf("find login user: %w", err)
	}
	token, err := GenerateToken(service.random)
	if err != nil {
		return IssuedSession{}, err
	}
	now := service.now().UTC()
	expiresAt := now.Add(service.sessionTTL)
	if err := service.store.InsertSession(ctx, SessionRecord{
		ID:        service.newID(),
		UserID:    user.ID,
		TokenHash: HashToken(token),
		UserAgent: metadata.UserAgent,
		IP:        metadata.IP,
		ExpiresAt: expiresAt,
		CreatedAt: now,
	}); err != nil {
		return IssuedSession{}, fmt.Errorf("persist session: %w", err)
	}
	return IssuedSession{
		Token:     token,
		ExpiresAt: expiresAt,
		User:      user,
	}, nil
}

// ResolveSession hashes the presented token and enforces expiry in storage.
func (service *Service) ResolveSession(
	ctx context.Context,
	token string,
) (User, error) {
	user, err := service.store.ResolveSessionHash(ctx, HashToken(token), service.now().UTC())
	if errors.Is(err, ErrUnauthenticated) {
		return User{}, ErrUnauthenticated
	}
	if err != nil {
		return User{}, fmt.Errorf("resolve session: %w", err)
	}
	return user, nil
}

// ResolveCredential preserves session kind metadata for shared bearer middleware.
func (service *Service) ResolveCredential(
	ctx context.Context,
	token string,
) (Credential, error) {
	user, err := service.ResolveSession(ctx, token)
	if err != nil {
		return Credential{}, err
	}
	return Credential{Kind: CredentialSession, User: user}, nil
}

// RevokeSession marks the matching hash revoked; unknown tokens are an
// idempotent no-op and historical metadata remains auditable.
func (service *Service) RevokeSession(ctx context.Context, token string) error {
	if err := service.store.DeleteSessionHash(ctx, HashToken(token)); err != nil {
		return fmt.Errorf("revoke session: %w", err)
	}
	return nil
}

// PostgresStore is the authoritative session persistence implementation.
//
// TODO(sqlc): move these isolated statements into pkg/db/queries after Berry
// selects a policy-compatible sqlc generator. Do not hand-edit pkg/db/gen.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// FindUserByEmail resolves a known user without case sensitivity.
func (store PostgresStore) FindUserByEmail(
	ctx context.Context,
	email string,
) (User, error) {
	user, err := scanUser(store.Pool.QueryRow(
		ctx,
		`SELECT id, email, name, avatar_url, role::text, last_workspace_id,
		        created_at, updated_at
		   FROM users
		  WHERE lower(email) = lower($1)
		  LIMIT 1`,
		email,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrInvalidCredentials
	}
	return user, err
}

// InsertSession persists only a SHA-256 token hash.
func (store PostgresStore) InsertSession(
	ctx context.Context,
	record SessionRecord,
) error {
	if store.Pool == nil {
		return errors.New("auth store pool is nil")
	}
	if _, err := store.Pool.Exec(
		ctx,
		`INSERT INTO sessions (
			id, user_id, token_hash, user_agent, ip, expires_at, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		record.ID,
		record.UserID,
		record.TokenHash,
		record.UserAgent,
		record.IP,
		record.ExpiresAt,
		record.CreatedAt,
	); err != nil {
		return errors.New("insert session")
	}
	return nil
}

// ResolveSessionHash returns only live sessions and their current user.
func (store PostgresStore) ResolveSessionHash(
	ctx context.Context,
	hash string,
	now time.Time,
) (User, error) {
	if store.Pool == nil {
		return User{}, errors.New("auth store pool is nil")
	}
	user, err := scanUser(store.Pool.QueryRow(
		ctx,
		`WITH live_session AS (
			UPDATE sessions
			   SET last_used_at = $2
			 WHERE token_hash = $1
			   AND expires_at > $2
			   AND revoked_at IS NULL
			 RETURNING user_id
		 )
		 SELECT u.id, u.email, u.name, u.avatar_url, u.role::text,
		        u.last_workspace_id, u.created_at, u.updated_at
		   FROM live_session AS s
		   JOIN users AS u ON u.id = s.user_id
		  LIMIT 1`,
		hash,
		now,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrUnauthenticated
	}
	return user, err
}

// DeleteSessionHash revokes a bearer session without accepting a raw token.
func (store PostgresStore) DeleteSessionHash(
	ctx context.Context,
	hash string,
) error {
	if store.Pool == nil {
		return errors.New("auth store pool is nil")
	}
	if _, err := store.Pool.Exec(
		ctx,
		`UPDATE sessions
		    SET revoked_at = COALESCE(revoked_at, now())
		  WHERE token_hash = $1`,
		hash,
	); err != nil {
		return errors.New("revoke session")
	}
	return nil
}

type userScanner interface {
	Scan(...any) error
}

func scanUser(row userScanner) (User, error) {
	var (
		user User
		role string
	)
	if err := row.Scan(
		&user.ID,
		&user.Email,
		&user.Name,
		&user.AvatarURL,
		&role,
		&user.CurrentWorkspaceID,
		&user.CreatedAt,
		&user.UpdatedAt,
	); err != nil {
		return User{}, err
	}
	user.Role = Role(role)
	return user, nil
}
