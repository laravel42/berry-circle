package integrations

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/integrations/oauth"
)

// PendingState is an issued authorisation being redeemed.
//
// CodeVerifier is plaintext because the caller is about to spend it on a token
// exchange. It is decrypted by ConsumeState and by nothing else.
type PendingState struct {
	oauth.State
	CodeVerifier string
}

// CreateState records an authorisation Berry is about to send a person into.
//
// Only the hash of the secret is stored. The secret itself goes in the
// authorisation URL and is never written down, so reading this table gives an
// attacker nothing they could present at the callback.
func (repository *Repository) CreateState(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	provider, redirectURI, secret, codeVerifier string,
	scopes []string,
	now time.Time,
) (uuid.UUID, error) {
	if secret == "" {
		return uuid.Nil, errors.New("integrations: oauth state secret is required")
	}
	sealedVerifier, err := repository.seal(codeVerifier)
	if err != nil {
		return uuid.Nil, fmt.Errorf("seal code verifier: %w", err)
	}
	if scopes == nil {
		scopes = []string{}
	}

	var id uuid.UUID
	err = repository.Pool.QueryRow(
		ctx,
		`INSERT INTO integration_oauth_states (
			state_hash, workspace_id, user_id, provider, redirect_uri,
			code_verifier_encrypted, scopes, created_at, expires_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		 RETURNING id`,
		oauth.HashSecret(secret), workspaceID, userID, provider, redirectURI,
		sealedVerifier, scopes, now.UTC(), now.UTC().Add(oauth.StateTTL),
	).Scan(&id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("create oauth state: %w", err)
	}
	return id, nil
}

// ConsumeState redeems an issued state exactly once.
//
// The redemption is a single conditional UPDATE rather than a read followed by
// a write: two callbacks arriving together must not both succeed, and only the
// database can decide that. The follow-up query exists purely to say *why* a
// redemption failed — it cannot resurrect one, because the update already
// committed or matched nothing.
func (repository *Repository) ConsumeState(
	ctx context.Context,
	secret string,
	now time.Time,
) (PendingState, error) {
	if secret == "" {
		return PendingState{}, oauth.ErrStateUnknown
	}
	hash := oauth.HashSecret(secret)
	moment := now.UTC()

	var (
		pending        PendingState
		sealedVerifier []byte
	)
	err := repository.Pool.QueryRow(
		ctx,
		`UPDATE integration_oauth_states
		    SET consumed_at = $2
		  WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > $2
		 RETURNING id, workspace_id, user_id, provider, redirect_uri,
		           code_verifier_encrypted, scopes, created_at, expires_at, consumed_at`,
		hash, moment,
	).Scan(
		&pending.ID, &pending.WorkspaceID, &pending.UserID, &pending.Provider,
		&pending.RedirectURI, &sealedVerifier, &pending.Scopes,
		&pending.CreatedAt, &pending.ExpiresAt, &pending.ConsumedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return PendingState{}, repository.classifyStateFailure(ctx, hash, moment)
	}
	if err != nil {
		return PendingState{}, fmt.Errorf("consume oauth state: %w", err)
	}

	if len(sealedVerifier) > 0 {
		verifier, err := repository.Sealer.Open(sealedVerifier)
		if err != nil {
			return PendingState{}, fmt.Errorf("open code verifier: %w", err)
		}
		pending.CodeVerifier = string(verifier)
	}
	return pending, nil
}

// classifyStateFailure turns a missed update into the specific reason, so the
// caller can distinguish a replay from a forgery from a person who took too
// long. All three refuse; only the operator-facing explanation differs.
func (repository *Repository) classifyStateFailure(
	ctx context.Context,
	hash []byte,
	now time.Time,
) error {
	var (
		consumedAt *time.Time
		expiresAt  time.Time
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT consumed_at, expires_at FROM integration_oauth_states WHERE state_hash = $1`,
		hash,
	).Scan(&consumedAt, &expiresAt)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return oauth.ErrStateUnknown
	case err != nil:
		return fmt.Errorf("classify oauth state: %w", err)
	case consumedAt != nil:
		return oauth.ErrStateUsed
	case !expiresAt.After(now):
		return oauth.ErrStateExpired
	}
	// The row became redeemable between the update and this read, which means
	// something else redeemed it. Treated as a replay: refusing a legitimate
	// retry is safe, completing someone else's flow is not.
	return oauth.ErrStateUsed
}

// PurgeExpiredStates removes states no callback can still redeem.
func (repository *Repository) PurgeExpiredStates(
	ctx context.Context,
	now time.Time,
) (int64, error) {
	tag, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM integration_oauth_states WHERE expires_at <= $1 OR consumed_at IS NOT NULL`,
		now.UTC(),
	)
	if err != nil {
		return 0, fmt.Errorf("purge oauth states: %w", err)
	}
	return tag.RowsAffected(), nil
}
