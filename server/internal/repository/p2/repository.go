package p2

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const maxSavedViewsPerUser = 100
const maxPinsPerUser = 100

// DefaultNotificationPreferences mirrors the column default from migration
// 022: every category on, including approvals, goals and workflows.
var DefaultNotificationPreferences = json.RawMessage(
	`{"inApp":{"assignments":true,"statusChanges":true,"comments":true,"mentions":true,"updates":true,"agentActivity":true,"approvals":true,"goals":true,"workflows":true}}`,
)

type Repository struct {
	Pool             *pgxpool.Pool
	StatementTimeout time.Duration
}

func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("p2 repository pool is nil")
	}
	return &Repository{Pool: pool, StatementTimeout: 3 * time.Second}, nil
}

type scanner interface {
	Scan(...any) error
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
		case "23001":
			return ErrApprovalRequired
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

const savedViewProjection = `
	id, workspace_id, owner_id, name, visibility, definition_version,
	query, display, revision, created_at, updated_at`

func (repository *Repository) ListSavedViews(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	after *SavedViewCursor,
	limit int,
) ([]SavedView, error) {
	if limit < 1 || limit > 101 {
		return nil, errors.New("list saved views: invalid limit")
	}
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.UpdatedAt, after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+savedViewProjection+`
		   FROM saved_issue_views
		  WHERE workspace_id = $1
		    AND (owner_id = $2 OR visibility = 'workspace')
		    AND (NOT $3::boolean OR
		        (updated_at, id) < ($4::timestamptz, $5::uuid))
		  ORDER BY updated_at DESC, id DESC
		  LIMIT $6`,
		workspaceID,
		userID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list saved views")
	}
	defer rows.Close()
	result := make([]SavedView, 0, limit)
	for rows.Next() {
		view, err := scanSavedView(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, view)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate saved views")
	}
	return result, nil
}

func (repository *Repository) CreateSavedView(
	ctx context.Context,
	params CreateSavedViewParams,
) (SavedView, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return SavedView{}, errors.New("begin saved view creation")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockUserWorkspace(ctx, tx, params.WorkspaceID, params.OwnerID, "views"); err != nil {
		return SavedView{}, err
	}
	var count int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM saved_issue_views
		  WHERE workspace_id = $1 AND owner_id = $2`,
		params.WorkspaceID,
		params.OwnerID,
	).Scan(&count); err != nil {
		return SavedView{}, errors.New("count saved views")
	}
	if count >= maxSavedViewsPerUser {
		return SavedView{}, ErrConflict
	}
	view, err := scanSavedView(tx.QueryRow(
		ctx,
		`INSERT INTO saved_issue_views (
			id, workspace_id, owner_id, name, visibility, definition_version,
			query, display, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $9)
		 RETURNING `+savedViewProjection,
		params.ID,
		params.WorkspaceID,
		params.OwnerID,
		params.Name,
		params.Visibility,
		params.DefinitionVersion,
		string(params.Query),
		string(params.Display),
		params.CreatedAt,
	))
	if err != nil {
		return SavedView{}, classifyWrite("create saved view", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return SavedView{}, errors.New("commit saved view creation")
	}
	return view, nil
}

func (repository *Repository) GetSavedView(
	ctx context.Context,
	workspaceID, userID, viewID uuid.UUID,
) (SavedView, error) {
	view, err := scanSavedView(repository.Pool.QueryRow(
		ctx,
		`SELECT `+savedViewProjection+`
		   FROM saved_issue_views
		  WHERE id = $1 AND workspace_id = $2
		    AND (owner_id = $3 OR visibility = 'workspace')`,
		viewID,
		workspaceID,
		userID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return SavedView{}, ErrNotFound
	}
	if err != nil {
		return SavedView{}, errors.New("get saved view")
	}
	return view, nil
}

func (repository *Repository) UpdateSavedView(
	ctx context.Context,
	params UpdateSavedViewParams,
) (SavedView, error) {
	var queryValue, displayValue any
	querySet, displaySet := len(params.Query) > 0, len(params.Display) > 0
	if querySet {
		queryValue = string(params.Query)
	}
	if displaySet {
		displayValue = string(params.Display)
	}
	view, err := scanSavedView(repository.Pool.QueryRow(
		ctx,
		`UPDATE saved_issue_views
		    SET name = CASE WHEN $4::boolean THEN $5::text ELSE name END,
		        visibility = CASE WHEN $6::boolean THEN $7::text ELSE visibility END,
		        query = CASE WHEN $8::boolean THEN $9::jsonb ELSE query END,
		        display = CASE WHEN $10::boolean THEN $11::jsonb ELSE display END,
		        revision = revision + 1,
		        updated_at = $12
		  WHERE id = $1 AND workspace_id = $2 AND owner_id = $3
		    AND revision = $13
		  RETURNING `+savedViewProjection,
		params.ID,
		params.WorkspaceID,
		params.ActorID,
		params.Name != nil,
		params.Name,
		params.Visibility != nil,
		params.Visibility,
		querySet,
		queryValue,
		displaySet,
		displayValue,
		params.UpdatedAt,
		params.ExpectedRevision,
	))
	if err == nil {
		return view, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SavedView{}, classifyWrite("update saved view", err)
	}
	var current int
	checkErr := repository.Pool.QueryRow(
		ctx,
		`SELECT revision FROM saved_issue_views
		  WHERE id = $1 AND workspace_id = $2 AND owner_id = $3`,
		params.ID,
		params.WorkspaceID,
		params.ActorID,
	).Scan(&current)
	if errors.Is(checkErr, pgx.ErrNoRows) {
		return SavedView{}, ErrNotFound
	}
	if checkErr != nil {
		return SavedView{}, errors.New("resolve saved view update")
	}
	return SavedView{}, ErrRevisionConflict
}

func (repository *Repository) DeleteSavedView(
	ctx context.Context,
	workspaceID, userID, viewID uuid.UUID,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin saved view deletion")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM saved_issue_views
		  WHERE id = $1 AND workspace_id = $2 AND owner_id = $3`,
		viewID,
		workspaceID,
		userID,
	)
	if err != nil {
		return errors.New("delete saved view")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if _, err := tx.Exec(
		ctx,
		`DELETE FROM user_pins
		  WHERE workspace_id = $1 AND target_type = 'view' AND target_id = $2`,
		workspaceID,
		viewID,
	); err != nil {
		return errors.New("delete saved view pins")
	}
	if err := compactPins(ctx, tx, workspaceID, nil); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit saved view deletion")
	}
	return nil
}

func scanSavedView(row scanner) (SavedView, error) {
	var (
		view    SavedView
		query   []byte
		display []byte
	)
	if err := row.Scan(
		&view.ID,
		&view.WorkspaceID,
		&view.OwnerID,
		&view.Name,
		&view.Visibility,
		&view.DefinitionVersion,
		&query,
		&display,
		&view.Revision,
		&view.CreatedAt,
		&view.UpdatedAt,
	); err != nil {
		return SavedView{}, err
	}
	view.Query = append(json.RawMessage(nil), query...)
	view.Display = append(json.RawMessage(nil), display...)
	return view, nil
}

func (repository *Repository) GetViewPreference(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
) (ViewPreference, error) {
	var (
		preference ViewPreference
		encoded    []byte
		updatedAt  time.Time
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT workspace_id, user_id, active_view_id, preferences, updated_at
		   FROM issue_view_preferences
		  WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID,
		userID,
	).Scan(
		&preference.WorkspaceID,
		&preference.UserID,
		&preference.ActiveView,
		&encoded,
		&updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ViewPreference{
			WorkspaceID: workspaceID,
			UserID:      userID,
			Preferences: json.RawMessage(`{}`),
		}, nil
	}
	if err != nil {
		return ViewPreference{}, errors.New("get view preference")
	}
	preference.Preferences = append(json.RawMessage(nil), encoded...)
	preference.UpdatedAt = &updatedAt
	return preference, nil
}

func (repository *Repository) PutViewPreference(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	activeView *uuid.UUID,
	preferences json.RawMessage,
	now time.Time,
) (ViewPreference, error) {
	if activeView != nil {
		if _, err := repository.GetSavedView(ctx, workspaceID, userID, *activeView); err != nil {
			return ViewPreference{}, err
		}
	}
	var (
		result    ViewPreference
		encoded   []byte
		updatedAt time.Time
	)
	err := repository.Pool.QueryRow(
		ctx,
		`INSERT INTO issue_view_preferences (
			workspace_id, user_id, active_view_id, preferences, updated_at
		 ) VALUES ($1, $2, $3, $4::jsonb, $5)
		 ON CONFLICT (workspace_id, user_id) DO UPDATE
		    SET active_view_id = EXCLUDED.active_view_id,
		        preferences = EXCLUDED.preferences,
		        updated_at = EXCLUDED.updated_at
		 RETURNING workspace_id, user_id, active_view_id, preferences, updated_at`,
		workspaceID,
		userID,
		activeView,
		string(preferences),
		now,
	).Scan(
		&result.WorkspaceID,
		&result.UserID,
		&result.ActiveView,
		&encoded,
		&updatedAt,
	)
	if err != nil {
		return ViewPreference{}, classifyWrite("put view preference", err)
	}
	result.Preferences = append(json.RawMessage(nil), encoded...)
	result.UpdatedAt = &updatedAt
	return result, nil
}

func (repository *Repository) ListPins(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
) ([]Pin, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT id, workspace_id, user_id, target_type, target_id, position, created_at
		   FROM user_pins
		  WHERE workspace_id = $1 AND user_id = $2
		  ORDER BY position ASC, id ASC
		  LIMIT 101`,
		workspaceID,
		userID,
	)
	if err != nil {
		return nil, errors.New("list pins")
	}
	defer rows.Close()
	result := make([]Pin, 0)
	for rows.Next() {
		var pin Pin
		if err := rows.Scan(
			&pin.ID,
			&pin.WorkspaceID,
			&pin.UserID,
			&pin.TargetType,
			&pin.TargetID,
			&pin.Position,
			&pin.CreatedAt,
		); err != nil {
			return nil, errors.New("scan pin")
		}
		result = append(result, pin)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate pins")
	}
	return result, nil
}

func (repository *Repository) CreatePin(
	ctx context.Context,
	id, workspaceID, userID uuid.UUID,
	targetType string,
	targetID uuid.UUID,
	now time.Time,
) (Pin, bool, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Pin{}, false, errors.New("begin pin creation")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockUserWorkspace(ctx, tx, workspaceID, userID, "pins"); err != nil {
		return Pin{}, false, err
	}
	var existing Pin
	err = tx.QueryRow(
		ctx,
		`SELECT id, workspace_id, user_id, target_type, target_id, position, created_at
		   FROM user_pins
		  WHERE workspace_id = $1 AND user_id = $2
		    AND target_type = $3 AND target_id = $4`,
		workspaceID,
		userID,
		targetType,
		targetID,
	).Scan(
		&existing.ID,
		&existing.WorkspaceID,
		&existing.UserID,
		&existing.TargetType,
		&existing.TargetID,
		&existing.Position,
		&existing.CreatedAt,
	)
	if err == nil {
		if err := tx.Commit(ctx); err != nil {
			return Pin{}, false, errors.New("commit pin replay")
		}
		return existing, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Pin{}, false, errors.New("read existing pin")
	}
	var count int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM user_pins WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID,
		userID,
	).Scan(&count); err != nil {
		return Pin{}, false, errors.New("count pins")
	}
	if count >= maxPinsPerUser {
		return Pin{}, false, ErrConflict
	}
	pin := Pin{
		ID:          id,
		WorkspaceID: workspaceID,
		UserID:      userID,
		TargetType:  targetType,
		TargetID:    targetID,
		Position:    count,
		CreatedAt:   now,
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO user_pins (
			id, workspace_id, user_id, target_type, target_id, position, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		pin.ID,
		pin.WorkspaceID,
		pin.UserID,
		pin.TargetType,
		pin.TargetID,
		pin.Position,
		pin.CreatedAt,
	); err != nil {
		return Pin{}, false, classifyWrite("create pin", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Pin{}, false, errors.New("commit pin creation")
	}
	return pin, false, nil
}

func (repository *Repository) ReorderPins(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	ids []uuid.UUID,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin pin reorder")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockUserWorkspace(ctx, tx, workspaceID, userID, "pins"); err != nil {
		return err
	}
	rows, err := tx.Query(
		ctx,
		`SELECT id FROM user_pins
		  WHERE workspace_id = $1 AND user_id = $2
		  ORDER BY position, id
		  FOR UPDATE`,
		workspaceID,
		userID,
	)
	if err != nil {
		return errors.New("lock pins")
	}
	current := make([]uuid.UUID, 0, len(ids))
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return errors.New("scan locked pin")
		}
		current = append(current, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return errors.New("iterate locked pins")
	}
	sortedCurrent := slices.Clone(current)
	sortedIDs := slices.Clone(ids)
	slices.SortFunc(sortedCurrent, func(a, b uuid.UUID) int {
		return bytes.Compare(a[:], b[:])
	})
	slices.SortFunc(sortedIDs, func(a, b uuid.UUID) int {
		return bytes.Compare(a[:], b[:])
	})
	if !slices.Equal(sortedCurrent, sortedIDs) {
		return ErrInvalidOrder
	}
	if _, err := tx.Exec(ctx, "SET CONSTRAINTS ALL DEFERRED"); err != nil {
		return errors.New("defer pin order constraint")
	}
	for position, id := range ids {
		tag, err := tx.Exec(
			ctx,
			`UPDATE user_pins SET position = $4
			  WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
			id,
			workspaceID,
			userID,
			position,
		)
		if err != nil || tag.RowsAffected() != 1 {
			return ErrInvalidOrder
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit pin reorder")
	}
	return nil
}

func (repository *Repository) DeletePin(
	ctx context.Context,
	workspaceID, userID, pinID uuid.UUID,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin pin deletion")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if err := lockUserWorkspace(ctx, tx, workspaceID, userID, "pins"); err != nil {
		return err
	}
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM user_pins WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
		pinID,
		workspaceID,
		userID,
	)
	if err != nil {
		return errors.New("delete pin")
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := compactPins(ctx, tx, workspaceID, &userID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit pin deletion")
	}
	return nil
}

func compactPins(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID uuid.UUID,
	userID *uuid.UUID,
) error {
	if _, err := tx.Exec(
		ctx,
		`UPDATE user_pins AS pin
		    SET position = ordered.position
		   FROM (
		        SELECT id, row_number() OVER (
		            PARTITION BY workspace_id, user_id
		            ORDER BY position, id
		        )::integer - 1 AS position
		          FROM user_pins
		         WHERE workspace_id = $1
		           AND ($2::uuid IS NULL OR user_id = $2)
		   ) AS ordered
		  WHERE pin.id = ordered.id
		    AND pin.position <> ordered.position`,
		workspaceID,
		userID,
	); err != nil {
		return errors.New("compact pin order")
	}
	return nil
}

func (repository *Repository) IssuePinTargetExists(
	ctx context.Context,
	workspaceID, issueID uuid.UUID,
) (bool, error) {
	var exists bool
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1 FROM issues AS issue
			JOIN boards AS board ON board.id = issue.board_id
			 AND issue.deleted_at IS NULL
			WHERE issue.id = $2 AND board.workspace_id = $1
		)`,
		workspaceID,
		issueID,
	).Scan(&exists)
	if err != nil {
		return false, errors.New("validate issue pin target")
	}
	return exists, nil
}

func (repository *Repository) ViewPinTargetExists(
	ctx context.Context,
	workspaceID, userID, viewID uuid.UUID,
) (bool, error) {
	var exists bool
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1 FROM saved_issue_views
			WHERE id = $3 AND workspace_id = $1
			  AND (owner_id = $2 OR visibility = 'workspace')
		)`,
		workspaceID,
		userID,
		viewID,
	).Scan(&exists)
	if err != nil {
		return false, errors.New("validate view pin target")
	}
	return exists, nil
}

func lockUserWorkspace(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, userID uuid.UUID,
	namespace string,
) error {
	_, err := tx.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(
			hashtextextended($1 || ':' || $2::text || ':' || $3::text, 0)
		)`,
		namespace,
		workspaceID,
		userID,
	)
	if err != nil {
		return errors.New("lock user workspace collection")
	}
	return nil
}

func (repository *Repository) GetNotificationPreferences(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
) (NotificationPreferences, error) {
	var (
		preference NotificationPreferences
		encoded    []byte
		updatedAt  time.Time
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT workspace_id, user_id, preferences, updated_at
		   FROM notification_preferences
		  WHERE workspace_id = $1 AND user_id = $2`,
		workspaceID,
		userID,
	).Scan(
		&preference.WorkspaceID,
		&preference.UserID,
		&encoded,
		&updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return NotificationPreferences{
			WorkspaceID: workspaceID,
			UserID:      userID,
			Preferences: append(json.RawMessage(nil), DefaultNotificationPreferences...),
		}, nil
	}
	if err != nil {
		return NotificationPreferences{}, errors.New("get notification preferences")
	}
	preference.Preferences = append(json.RawMessage(nil), encoded...)
	preference.UpdatedAt = &updatedAt
	return preference, nil
}

func (repository *Repository) PutNotificationPreferences(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	preferences json.RawMessage,
	now time.Time,
) (NotificationPreferences, error) {
	var (
		result    NotificationPreferences
		encoded   []byte
		updatedAt time.Time
	)
	err := repository.Pool.QueryRow(
		ctx,
		`INSERT INTO notification_preferences (
			workspace_id, user_id, preferences, updated_at
		 ) VALUES ($1, $2, $3::jsonb, $4)
		 ON CONFLICT (workspace_id, user_id) DO UPDATE
		    SET preferences = EXCLUDED.preferences,
		        updated_at = EXCLUDED.updated_at
		 RETURNING workspace_id, user_id, preferences, updated_at`,
		workspaceID,
		userID,
		string(preferences),
		now,
	).Scan(&result.WorkspaceID, &result.UserID, &encoded, &updatedAt)
	if err != nil {
		return NotificationPreferences{}, classifyWrite("put notification preferences", err)
	}
	result.Preferences = append(json.RawMessage(nil), encoded...)
	result.UpdatedAt = &updatedAt
	return result, nil
}
