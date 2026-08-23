package identity

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
)

// FindPersonalToken implements auth.PersonalTokenStore. It returns no raw
// bearer material and intentionally collapses unknown public IDs.
func (repository *Repository) FindPersonalToken(
	ctx context.Context,
	publicID string,
) (coreauth.StoredPersonalToken, error) {
	var (
		record     coreauth.StoredPersonalToken
		secretHash []byte
		role       string
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT t.id, t.secret_hash, t.expires_at, t.revoked_at,
		        u.id, u.email, u.name, u.avatar_url, u.role::text,
		        u.last_workspace_id, u.created_at, u.updated_at
		   FROM personal_api_tokens AS t
		   JOIN users AS u ON u.id = t.user_id
		  WHERE t.public_id = $1`,
		publicID,
	).Scan(
		&record.ID,
		&secretHash,
		&record.ExpiresAt,
		&record.RevokedAt,
		&record.User.ID,
		&record.User.Email,
		&record.User.Name,
		&record.User.AvatarURL,
		&role,
		&record.User.CurrentWorkspaceID,
		&record.User.CreatedAt,
		&record.User.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return coreauth.StoredPersonalToken{}, coreauth.ErrUnauthenticated
	}
	if err != nil {
		return coreauth.StoredPersonalToken{}, errors.New("find personal API token")
	}
	if len(secretHash) != sha256.Size {
		return coreauth.StoredPersonalToken{}, errors.New("personal API token hash is invalid")
	}
	copy(record.SecretHash[:], secretHash)
	record.User.Role = coreauth.Role(role)
	return record, nil
}

// TouchPersonalToken records successful verification synchronously.
func (repository *Repository) TouchPersonalToken(
	ctx context.Context,
	tokenID uuid.UUID,
	usedAt time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE personal_api_tokens
		    SET last_used_at = GREATEST(COALESCE(last_used_at, $2), $2)
		  WHERE id = $1 AND revoked_at IS NULL`,
		tokenID,
		usedAt,
	)
	if err != nil {
		return errors.New("touch personal API token")
	}
	if tag.RowsAffected() != 1 {
		return coreauth.ErrUnauthenticated
	}
	return nil
}

const personalTokenProjection = `
	id, name, ('berry_pat_' || public_id), expires_at, last_used_at,
	revoked_at, created_at`

// CreatePersonalToken persists only the secret digest. An idempotent replay
// returns metadata but never reconstructs or replays the secret.
func (repository *Repository) CreatePersonalToken(
	ctx context.Context,
	params CreatePersonalTokenParams,
) (PersonalToken, bool, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return PersonalToken{}, false, errors.New("begin personal token creation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	token, err := scanPersonalToken(tx.QueryRow(
		ctx,
		`INSERT INTO personal_api_tokens (
			id, user_id, name, public_id, secret_hash,
			idempotency_key_hash, request_fingerprint, expires_at, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 ON CONFLICT (user_id, idempotency_key_hash) DO NOTHING
		 RETURNING `+personalTokenProjection,
		params.ID,
		params.UserID,
		params.Name,
		params.PublicID,
		params.SecretHash[:],
		params.IdempotencyKeyHash[:],
		params.Fingerprint[:],
		params.ExpiresAt,
		params.CreatedAt,
	))
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return PersonalToken{}, false, errors.New("commit personal token creation")
		}
		return token, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return PersonalToken{}, false, classifyWrite("create personal API token", err)
	}

	var existingFingerprint []byte
	token, err = scanPersonalToken(tx.QueryRow(
		ctx,
		`SELECT `+personalTokenProjection+`
		   FROM personal_api_tokens
		  WHERE user_id = $1 AND idempotency_key_hash = $2`,
		params.UserID,
		params.IdempotencyKeyHash[:],
	))
	if err != nil {
		return PersonalToken{}, false, errors.New("read personal token idempotency result")
	}
	if err := tx.QueryRow(
		ctx,
		`SELECT request_fingerprint
		   FROM personal_api_tokens
		  WHERE user_id = $1 AND idempotency_key_hash = $2`,
		params.UserID,
		params.IdempotencyKeyHash[:],
	).Scan(&existingFingerprint); err != nil {
		return PersonalToken{}, false, errors.New("read personal token fingerprint")
	}
	if subtle.ConstantTimeCompare(existingFingerprint, params.Fingerprint[:]) != 1 {
		return PersonalToken{}, false, ErrIdempotencyConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return PersonalToken{}, false, errors.New("commit personal token replay")
	}
	return token, true, nil
}

// ListPersonalTokens returns only tokens owned by the caller.
func (repository *Repository) ListPersonalTokens(
	ctx context.Context,
	userID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]PersonalToken, error) {
	if limit < 1 {
		return nil, errors.New("list personal tokens: invalid limit")
	}
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime = after.CreatedAt
		afterID = after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+personalTokenProjection+`
		   FROM personal_api_tokens
		  WHERE user_id = $1
		    AND (NOT $2::boolean OR
		        (created_at, id) < ($3::timestamptz, $4::uuid))
		  ORDER BY created_at DESC, id DESC
		  LIMIT $5`,
		userID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list personal API tokens")
	}
	defer rows.Close()
	result := make([]PersonalToken, 0, limit)
	for rows.Next() {
		token, err := scanPersonalToken(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, token)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate personal API tokens")
	}
	return result, nil
}

// RevokePersonalToken is idempotent for unknown/already-revoked owned IDs.
func (repository *Repository) RevokePersonalToken(
	ctx context.Context,
	userID, tokenID uuid.UUID,
	revokedAt time.Time,
) error {
	if _, err := repository.Pool.Exec(
		ctx,
		`UPDATE personal_api_tokens
		    SET revoked_at = COALESCE(revoked_at, $3)
		  WHERE id = $1 AND user_id = $2`,
		tokenID,
		userID,
		revokedAt,
	); err != nil {
		return errors.New("revoke personal API token")
	}
	return nil
}

func scanPersonalToken(row scanner) (PersonalToken, error) {
	var token PersonalToken
	if err := row.Scan(
		&token.ID,
		&token.Name,
		&token.Prefix,
		&token.ExpiresAt,
		&token.LastUsedAt,
		&token.RevokedAt,
		&token.CreatedAt,
	); err != nil {
		return PersonalToken{}, err
	}
	return token, nil
}

const invitationProjection = `
	id, workspace_id, email, role::text, invited_by, expires_at,
	accepted_at, revoked_at, created_at`

// CreateInvitation expires stale pending rows and persists only a token digest.
func (repository *Repository) CreateInvitation(
	ctx context.Context,
	params CreateInvitationParams,
) (Invitation, bool, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Invitation{}, false, errors.New("begin invitation creation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	if _, err := tx.Exec(
		ctx,
		`UPDATE workspace_invitations
		    SET revoked_at = $3
		  WHERE workspace_id = $1
		    AND email = $2
		    AND accepted_at IS NULL
		    AND revoked_at IS NULL
		    AND expires_at <= $3`,
		params.WorkspaceID,
		params.Email,
		params.CreatedAt,
	); err != nil {
		return Invitation{}, false, errors.New("expire stale workspace invitation")
	}
	var role string
	invitation := Invitation{}
	err = tx.QueryRow(
		ctx,
		`INSERT INTO workspace_invitations (
			id, workspace_id, email, role, invited_by, token_hash,
			idempotency_key_hash, request_fingerprint, expires_at, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 ON CONFLICT (workspace_id, invited_by, idempotency_key_hash) DO NOTHING
		 RETURNING `+invitationProjection,
		params.ID,
		params.WorkspaceID,
		params.Email,
		string(params.Role),
		params.ActorID,
		params.TokenHash[:],
		params.IdempotencyKeyHash[:],
		params.Fingerprint[:],
		params.ExpiresAt,
		params.CreatedAt,
	).Scan(
		&invitation.ID,
		&invitation.WorkspaceID,
		&invitation.Email,
		&role,
		&invitation.InvitedBy,
		&invitation.ExpiresAt,
		&invitation.AcceptedAt,
		&invitation.RevokedAt,
		&invitation.CreatedAt,
	)
	if err == nil {
		invitation.Role = Role(role)
		if err := tx.Commit(ctx); err != nil {
			return Invitation{}, false, errors.New("commit invitation creation")
		}
		return invitation, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Invitation{}, false, classifyWrite("create workspace invitation", err)
	}

	var (
		existingFingerprint []byte
		existingRole        string
	)
	err = tx.QueryRow(
		ctx,
		`SELECT `+invitationProjection+`, request_fingerprint
		   FROM workspace_invitations
		  WHERE workspace_id = $1
		    AND invited_by = $2
		    AND idempotency_key_hash = $3`,
		params.WorkspaceID,
		params.ActorID,
		params.IdempotencyKeyHash[:],
	).Scan(
		&invitation.ID,
		&invitation.WorkspaceID,
		&invitation.Email,
		&existingRole,
		&invitation.InvitedBy,
		&invitation.ExpiresAt,
		&invitation.AcceptedAt,
		&invitation.RevokedAt,
		&invitation.CreatedAt,
		&existingFingerprint,
	)
	if err != nil {
		return Invitation{}, false, errors.New("read invitation idempotency result")
	}
	if subtle.ConstantTimeCompare(existingFingerprint, params.Fingerprint[:]) != 1 {
		return Invitation{}, false, ErrIdempotencyConflict
	}
	invitation.Role = Role(existingRole)
	if err := tx.Commit(ctx); err != nil {
		return Invitation{}, false, errors.New("commit invitation replay")
	}
	return invitation, true, nil
}

// ListWorkspaceInvitations returns a stable page after admin authorization.
func (repository *Repository) ListWorkspaceInvitations(
	ctx context.Context,
	workspaceID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]Invitation, error) {
	return repository.listInvitations(
		ctx,
		`workspace_id = $1`,
		[]any{workspaceID},
		after,
		limit,
	)
}

// ListPersonalInvitations returns only live invitations matching the user's
// normalized email.
func (repository *Repository) ListPersonalInvitations(
	ctx context.Context,
	email string,
	now time.Time,
	after *TimeCursor,
	limit int,
) ([]Invitation, error) {
	return repository.listInvitations(
		ctx,
		`email = $1
		 AND accepted_at IS NULL
		 AND revoked_at IS NULL
		 AND expires_at > $2
		 AND EXISTS (
		    SELECT 1
		      FROM workspaces AS workspace
		     WHERE workspace.id = workspace_invitations.workspace_id
		       AND workspace.deleted_at IS NULL
		 )`,
		[]any{email, now},
		after,
		limit,
	)
}

func (repository *Repository) listInvitations(
	ctx context.Context,
	predicate string,
	arguments []any,
	after *TimeCursor,
	limit int,
) ([]Invitation, error) {
	if limit < 1 {
		return nil, errors.New("list invitations: invalid limit")
	}
	query := `SELECT ` + invitationProjection + `
		FROM workspace_invitations WHERE ` + predicate
	if after != nil {
		query += ` AND (created_at, id) < ($` +
			fmt.Sprint(len(arguments)+1) + `::timestamptz, $` +
			fmt.Sprint(len(arguments)+2) + `::uuid)`
		arguments = append(arguments, after.CreatedAt, after.ID)
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT $` +
		fmt.Sprint(len(arguments)+1)
	arguments = append(arguments, limit)
	rows, err := repository.Pool.Query(ctx, query, arguments...)
	if err != nil {
		return nil, errors.New("list workspace invitations")
	}
	defer rows.Close()
	result := make([]Invitation, 0, limit)
	for rows.Next() {
		invitation, err := scanInvitation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, invitation)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate workspace invitations")
	}
	return result, nil
}

// RevokeInvitation marks one active workspace invitation revoked.
func (repository *Repository) RevokeInvitation(
	ctx context.Context,
	workspaceID, invitationID uuid.UUID,
	now time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE workspace_invitations
		    SET revoked_at = COALESCE(revoked_at, $3)
		  WHERE id = $1
		    AND workspace_id = $2
		    AND accepted_at IS NULL`,
		invitationID,
		workspaceID,
		now,
	)
	if err != nil {
		return errors.New("revoke workspace invitation")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// AcceptInvitation verifies recipient and secret under one row lock and creates
// membership atomically. Every invalid state deliberately returns one error.
func (repository *Repository) AcceptInvitation(
	ctx context.Context,
	invitationID, userID uuid.UUID,
	userEmail string,
	presentedHash [sha256.Size]byte,
	now time.Time,
) (Membership, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Membership{}, errors.New("begin invitation acceptance")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var (
		workspaceID uuid.UUID
		email       string
		role        string
		storedHash  []byte
		expiresAt   time.Time
		acceptedAt  *time.Time
		acceptedBy  *uuid.UUID
		revokedAt   *time.Time
	)
	err = tx.QueryRow(
		ctx,
		`SELECT workspace_id, email, role::text, token_hash, expires_at,
		        accepted_at, accepted_by, revoked_at
		   FROM workspace_invitations AS invitation
		   JOIN workspaces AS workspace
		     ON workspace.id = invitation.workspace_id
		    AND workspace.deleted_at IS NULL
		  WHERE invitation.id = $1
		  FOR UPDATE OF invitation`,
		invitationID,
	).Scan(
		&workspaceID,
		&email,
		&role,
		&storedHash,
		&expiresAt,
		&acceptedAt,
		&acceptedBy,
		&revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Membership{}, ErrInvitationInvalid
	}
	if err != nil {
		return Membership{}, errors.New("lock workspace invitation")
	}
	validHash := len(storedHash) == sha256.Size &&
		subtle.ConstantTimeCompare(storedHash, presentedHash[:]) == 1
	if !validHash || email != userEmail || revokedAt != nil || !expiresAt.After(now) {
		return Membership{}, ErrInvitationInvalid
	}
	if acceptedAt != nil {
		if acceptedBy == nil || *acceptedBy != userID {
			return Membership{}, ErrInvitationInvalid
		}
		member, err := getMembershipTx(ctx, tx, workspaceID, userID)
		if err != nil {
			return Membership{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Membership{}, errors.New("commit invitation acceptance replay")
		}
		return member, nil
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO workspace_memberships (
			workspace_id, user_id, role, joined_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $4)
		 ON CONFLICT (workspace_id, user_id) DO NOTHING`,
		workspaceID,
		userID,
		role,
		now,
	); err != nil {
		return Membership{}, classifyWrite("create invited membership", err)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE workspace_invitations
		    SET accepted_at = $2, accepted_by = $3
		  WHERE id = $1`,
		invitationID,
		now,
		userID,
	); err != nil {
		return Membership{}, errors.New("mark workspace invitation accepted")
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE users
		    SET last_workspace_id = $2,
		        onboarding_state =
		            '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
		        onboarding_completed_at = COALESCE(onboarding_completed_at, $3),
		        updated_at = $3
		  WHERE id = $1`,
		userID,
		workspaceID,
		now,
	); err != nil {
		return Membership{}, errors.New("select invited workspace")
	}
	member, err := getMembershipTx(ctx, tx, workspaceID, userID)
	if err != nil {
		return Membership{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Membership{}, errors.New("commit invitation acceptance")
	}
	return member, nil
}

func getMembershipTx(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, userID uuid.UUID,
) (Membership, error) {
	member, err := scanMembership(tx.QueryRow(
		ctx,
		`SELECT `+membershipProjection+`
		   FROM workspace_memberships AS m
		   JOIN users AS u ON u.id = m.user_id
		  WHERE m.workspace_id = $1 AND m.user_id = $2`,
		workspaceID,
		userID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Membership{}, ErrNotFound
	}
	return member, err
}

func scanInvitation(row scanner) (Invitation, error) {
	var (
		invitation Invitation
		role       string
	)
	if err := row.Scan(
		&invitation.ID,
		&invitation.WorkspaceID,
		&invitation.Email,
		&role,
		&invitation.InvitedBy,
		&invitation.ExpiresAt,
		&invitation.AcceptedAt,
		&invitation.RevokedAt,
		&invitation.CreatedAt,
	); err != nil {
		return Invitation{}, err
	}
	invitation.Role = Role(role)
	return invitation, nil
}
