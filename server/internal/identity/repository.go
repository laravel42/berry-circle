package identity

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository is the PostgreSQL boundary for Berry's P1 identity domain.
//
// TODO(sqlc): move these statements into query inputs after Berry has a
// policy-compatible sqlc distribution. Generated files are not hand-edited.
type Repository struct {
	Pool *pgxpool.Pool
}

// NewRepository requires Berry's authoritative PostgreSQL pool.
func NewRepository(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("identity repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

type scanner interface {
	Scan(...any) error
}

func encodeJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("encode identity JSON")
	}
	return encoded, nil
}

func decodeJSON[T any](encoded []byte) (T, error) {
	var value T
	if err := json.Unmarshal(encoded, &value); err != nil {
		return value, errors.New("decode identity JSON")
	}
	return value, nil
}

func classifyWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23P01":
			return ErrConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// GetProfile returns the current account and persisted shell state.
func (repository *Repository) GetProfile(
	ctx context.Context,
	userID uuid.UUID,
) (Profile, *uuid.UUID, error) {
	var (
		profile        Profile
		settingsJSON   []byte
		onboardingJSON []byte
		current        *uuid.UUID
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT id, email, name, avatar_url, settings, onboarding_state,
		        onboarding_completed_at, last_workspace_id, created_at, updated_at
		   FROM users
		  WHERE id = $1`,
		userID,
	).Scan(
		&profile.ID,
		&profile.Email,
		&profile.Name,
		&profile.AvatarURL,
		&settingsJSON,
		&onboardingJSON,
		&profile.OnboardedAt,
		&current,
		&profile.CreatedAt,
		&profile.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, nil, ErrNotFound
	}
	if err != nil {
		return Profile{}, nil, errors.New("get identity profile")
	}
	settings, err := decodeJSON[UserSettings](settingsJSON)
	if err != nil {
		return Profile{}, nil, err
	}
	onboarding, err := decodeJSON[OnboardingState](onboardingJSON)
	if err != nil {
		return Profile{}, nil, err
	}
	profile.Settings = settings
	profile.Onboarding = onboarding
	return profile, current, nil
}

// UpdateProfile mutates only bounded public profile fields.
func (repository *Repository) UpdateProfile(
	ctx context.Context,
	userID uuid.UUID,
	patch ProfilePatch,
	now time.Time,
) (Profile, error) {
	row := repository.Pool.QueryRow(
		ctx,
		`UPDATE users
		    SET name = CASE WHEN $2 THEN $3::text ELSE name END,
		        avatar_url = CASE WHEN $4 THEN $5::text ELSE avatar_url END,
		        updated_at = $6
		  WHERE id = $1
		  RETURNING id, email, name, avatar_url, settings, onboarding_state,
		            onboarding_completed_at, last_workspace_id, created_at, updated_at`,
		userID,
		patch.Name != nil,
		patch.Name,
		patch.AvatarURLSet,
		patch.AvatarURL,
		now,
	)
	profile, _, err := scanProfile(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, ErrNotFound
	}
	return profile, err
}

// UpdateUserSettings replaces a previously validated complete settings value.
func (repository *Repository) UpdateUserSettings(
	ctx context.Context,
	userID uuid.UUID,
	settings UserSettings,
	now time.Time,
) (UserSettings, error) {
	encoded, err := encodeJSON(settings)
	if err != nil {
		return UserSettings{}, err
	}
	var result []byte
	err = repository.Pool.QueryRow(
		ctx,
		`UPDATE users
		    SET settings = $2::jsonb, updated_at = $3
		  WHERE id = $1
		  RETURNING settings`,
		userID,
		encoded,
		now,
	).Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserSettings{}, ErrNotFound
	}
	if err != nil {
		return UserSettings{}, errors.New("update user settings")
	}
	return decodeJSON[UserSettings](result)
}

// UpdateOnboarding persists one complete, validated resumable state.
func (repository *Repository) UpdateOnboarding(
	ctx context.Context,
	userID uuid.UUID,
	state OnboardingState,
	now time.Time,
) (OnboardingState, *time.Time, error) {
	encoded, err := encodeJSON(state)
	if err != nil {
		return OnboardingState{}, nil, err
	}
	var (
		result      []byte
		completedAt *time.Time
	)
	err = repository.Pool.QueryRow(
		ctx,
		`UPDATE users
		    SET onboarding_state = $2::jsonb,
		        onboarding_completed_at = CASE
		            WHEN $3 THEN COALESCE(onboarding_completed_at, $4)
		            ELSE NULL
		        END,
		        updated_at = $4
		  WHERE id = $1
		  RETURNING onboarding_state, onboarding_completed_at`,
		userID,
		encoded,
		state.Completed,
		now,
	).Scan(&result, &completedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return OnboardingState{}, nil, ErrNotFound
	}
	if err != nil {
		return OnboardingState{}, nil, errors.New("update onboarding state")
	}
	decoded, err := decodeJSON[OnboardingState](result)
	return decoded, completedAt, err
}

func scanProfile(row scanner) (Profile, *uuid.UUID, error) {
	var (
		profile        Profile
		settingsJSON   []byte
		onboardingJSON []byte
		current        *uuid.UUID
	)
	if err := row.Scan(
		&profile.ID,
		&profile.Email,
		&profile.Name,
		&profile.AvatarURL,
		&settingsJSON,
		&onboardingJSON,
		&profile.OnboardedAt,
		&current,
		&profile.CreatedAt,
		&profile.UpdatedAt,
	); err != nil {
		return Profile{}, nil, err
	}
	settings, err := decodeJSON[UserSettings](settingsJSON)
	if err != nil {
		return Profile{}, nil, err
	}
	onboarding, err := decodeJSON[OnboardingState](onboardingJSON)
	if err != nil {
		return Profile{}, nil, err
	}
	profile.Settings = settings
	profile.Onboarding = onboarding
	return profile, current, nil
}

const workspaceProjection = `
	w.id, w.name, w.slug, w.description, w.settings,
	m.role::text, w.created_at, w.updated_at`

// ListWorkspaces returns only active workspaces visible to the user.
func (repository *Repository) ListWorkspaces(
	ctx context.Context,
	userID uuid.UUID,
	after *TimeCursor,
	limit int,
) ([]Workspace, error) {
	if limit < 1 {
		return nil, errors.New("list workspaces: invalid limit")
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
		`SELECT `+workspaceProjection+`
		   FROM workspace_memberships AS m
		   JOIN workspaces AS w ON w.id = m.workspace_id
		  WHERE m.user_id = $1
		    AND w.deleted_at IS NULL
		    AND (NOT $2::boolean OR
		        (w.created_at, w.id) < ($3::timestamptz, $4::uuid))
		  ORDER BY w.created_at DESC, w.id DESC
		  LIMIT $5`,
		userID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list workspaces")
	}
	defer rows.Close()
	result := make([]Workspace, 0, limit)
	for rows.Next() {
		workspace, err := scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, workspace)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate workspaces")
	}
	return result, nil
}

// GetWorkspace hides non-members and deleted workspaces with ErrNotFound.
func (repository *Repository) GetWorkspace(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
) (Workspace, error) {
	workspace, err := scanWorkspace(repository.Pool.QueryRow(
		ctx,
		`SELECT `+workspaceProjection+`
		   FROM workspace_memberships AS m
		   JOIN workspaces AS w ON w.id = m.workspace_id
		  WHERE w.id = $1 AND m.user_id = $2 AND w.deleted_at IS NULL`,
		workspaceID,
		userID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Workspace{}, ErrNotFound
	}
	return workspace, err
}

// CreateWorkspace atomically creates its owner membership and selects it.
func (repository *Repository) CreateWorkspace(
	ctx context.Context,
	params CreateWorkspaceParams,
) (Workspace, bool, error) {
	settings, err := encodeJSON(params.Settings)
	if err != nil {
		return Workspace{}, false, err
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Workspace{}, false, errors.New("begin workspace creation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var inserted bool
	err = tx.QueryRow(
		ctx,
		`INSERT INTO workspaces (
			id, name, slug, description, settings, created_by,
			creation_key_hash, creation_fingerprint, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9)
		 ON CONFLICT (created_by, creation_key_hash)
		 WHERE created_by IS NOT NULL AND creation_key_hash IS NOT NULL
		 DO NOTHING
		 RETURNING true`,
		params.ID,
		params.Name,
		params.Slug,
		params.Description,
		settings,
		params.ActorID,
		params.IdempotencyKeyHash[:],
		params.Fingerprint[:],
		params.CreatedAt,
	).Scan(&inserted)
	if err == nil {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO workspace_memberships (
				workspace_id, user_id, role, joined_at, updated_at
			 ) VALUES ($1, $2, 'owner', $3, $3)`,
			params.ID,
			params.ActorID,
			params.CreatedAt,
		); err != nil {
			return Workspace{}, false, classifyWrite("create owner membership", err)
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE users SET last_workspace_id = $2, updated_at = $3 WHERE id = $1`,
			params.ActorID,
			params.ID,
			params.CreatedAt,
		); err != nil {
			return Workspace{}, false, classifyWrite("select created workspace", err)
		}
		workspace, err := getWorkspaceTx(ctx, tx, params.ID, params.ActorID)
		if err != nil {
			return Workspace{}, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Workspace{}, false, errors.New("commit workspace creation")
		}
		return workspace, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Workspace{}, false, classifyWrite("create workspace", err)
	}

	var (
		existingID          uuid.UUID
		existingFingerprint []byte
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT id, creation_fingerprint
		   FROM workspaces
		  WHERE created_by = $1 AND creation_key_hash = $2`,
		params.ActorID,
		params.IdempotencyKeyHash[:],
	).Scan(&existingID, &existingFingerprint); err != nil {
		return Workspace{}, false, errors.New("read workspace idempotency result")
	}
	if subtle.ConstantTimeCompare(existingFingerprint, params.Fingerprint[:]) != 1 {
		return Workspace{}, false, ErrIdempotencyConflict
	}
	workspace, err := getWorkspaceTx(ctx, tx, existingID, params.ActorID)
	if err != nil {
		return Workspace{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Workspace{}, false, errors.New("commit workspace replay")
	}
	return workspace, true, nil
}

// UpdateWorkspace replaces validated mutable fields after service authorization.
func (repository *Repository) UpdateWorkspace(
	ctx context.Context,
	workspaceID uuid.UUID,
	patch WorkspacePatch,
	now time.Time,
) (Workspace, error) {
	var (
		settingsJSON []byte
		role         string
		workspace    Workspace
	)
	err := repository.Pool.QueryRow(
		ctx,
		`UPDATE workspaces
		    SET name = CASE WHEN $2 THEN $3::text ELSE name END,
		        slug = CASE WHEN $4 THEN $5::text ELSE slug END,
		        description = CASE WHEN $6 THEN $7::text ELSE description END,
		        updated_at = $8
		  WHERE id = $1 AND deleted_at IS NULL
		  RETURNING id, name, slug, description, settings, created_at, updated_at`,
		workspaceID,
		patch.Name != nil,
		patch.Name,
		patch.Slug != nil,
		patch.Slug,
		patch.DescriptionSet,
		patch.Description,
		now,
	).Scan(
		&workspace.ID,
		&workspace.Name,
		&workspace.Slug,
		&workspace.Description,
		&settingsJSON,
		&workspace.CreatedAt,
		&workspace.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Workspace{}, ErrNotFound
	}
	if err != nil {
		return Workspace{}, classifyWrite("update workspace", err)
	}
	settings, err := decodeJSON[WorkspaceSettings](settingsJSON)
	if err != nil {
		return Workspace{}, err
	}
	workspace.Settings = settings
	workspace.Role = Role(role)
	return workspace, nil
}

// UpdateWorkspaceSettings replaces a validated complete settings value.
func (repository *Repository) UpdateWorkspaceSettings(
	ctx context.Context,
	workspaceID uuid.UUID,
	settings WorkspaceSettings,
	now time.Time,
) (WorkspaceSettings, error) {
	encoded, err := encodeJSON(settings)
	if err != nil {
		return WorkspaceSettings{}, err
	}
	var result []byte
	err = repository.Pool.QueryRow(
		ctx,
		`UPDATE workspaces SET settings = $2::jsonb, updated_at = $3
		  WHERE id = $1 AND deleted_at IS NULL
		  RETURNING settings`,
		workspaceID,
		encoded,
		now,
	).Scan(&result)
	if errors.Is(err, pgx.ErrNoRows) {
		return WorkspaceSettings{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceSettings{}, errors.New("update workspace settings")
	}
	return decodeJSON[WorkspaceSettings](result)
}

// DeleteWorkspace soft-deletes a workspace so product rows remain intact.
func (repository *Repository) DeleteWorkspace(
	ctx context.Context,
	workspaceID uuid.UUID,
	now time.Time,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin workspace deletion")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	tag, err := tx.Exec(
		ctx,
		`UPDATE workspaces
		    SET deleted_at = $2, updated_at = $2
		  WHERE id = $1 AND deleted_at IS NULL`,
		workspaceID,
		now,
	)
	if err != nil {
		return errors.New("delete workspace")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE users
		    SET last_workspace_id = NULL, updated_at = $2
		  WHERE last_workspace_id = $1`,
		workspaceID,
		now,
	); err != nil {
		return errors.New("clear deleted workspace selection")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit workspace deletion")
	}
	return nil
}

// SelectWorkspace updates the account's current workspace only when membership
// exists and the workspace is active.
func (repository *Repository) SelectWorkspace(
	ctx context.Context,
	userID, workspaceID uuid.UUID,
	now time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE users AS u
		    SET last_workspace_id = $2, updated_at = $3
		  WHERE u.id = $1
		    AND EXISTS (
		        SELECT 1
		          FROM workspace_memberships AS m
		          JOIN workspaces AS w
		            ON w.id = m.workspace_id AND w.deleted_at IS NULL
		         WHERE m.user_id = u.id AND m.workspace_id = $2
		    )`,
		userID,
		workspaceID,
		now,
	)
	if err != nil {
		return errors.New("select workspace")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

func getWorkspaceTx(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, userID uuid.UUID,
) (Workspace, error) {
	workspace, err := scanWorkspace(tx.QueryRow(
		ctx,
		`SELECT `+workspaceProjection+`
		   FROM workspace_memberships AS m
		   JOIN workspaces AS w ON w.id = m.workspace_id
		  WHERE w.id = $1 AND m.user_id = $2 AND w.deleted_at IS NULL`,
		workspaceID,
		userID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Workspace{}, ErrNotFound
	}
	return workspace, err
}

func scanWorkspace(row scanner) (Workspace, error) {
	var (
		workspace    Workspace
		settingsJSON []byte
		role         string
	)
	if err := row.Scan(
		&workspace.ID,
		&workspace.Name,
		&workspace.Slug,
		&workspace.Description,
		&settingsJSON,
		&role,
		&workspace.CreatedAt,
		&workspace.UpdatedAt,
	); err != nil {
		return Workspace{}, err
	}
	settings, err := decodeJSON[WorkspaceSettings](settingsJSON)
	if err != nil {
		return Workspace{}, err
	}
	workspace.Settings = settings
	workspace.Role = Role(role)
	return workspace, nil
}
