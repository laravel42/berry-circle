package agents

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Agent is Berry's durable product identity mapped to one upstream agent.
type Agent struct {
	ID              uuid.UUID
	BoardID         *uuid.UUID
	OpenFangAgentID uuid.UUID
	Name            string
	Description     *string
	AvatarURL       *string
	Status          string
	Capabilities    []string
	// Instructions is the system prompt applied to every task this agent runs.
	Instructions         *string
	ModelProvider        *string
	ModelName            *string
	ModelTier            *string
	AuthStatus           *string
	UpstreamState        *string
	UpstreamLastActiveAt *time.Time
	LastSyncedAt         *time.Time
	ArchivedAt           *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// Cursor is the stable (name, id) forward-pagination key.
type Cursor struct {
	Name string    `json:"name"`
	ID   uuid.UUID `json:"id"`
}

// SummaryUpdate is a validated runtime summary ready for persistence.
type SummaryUpdate struct {
	Description          *string
	ID                   uuid.UUID
	WorkspaceID          uuid.UUID
	OpenFangAgentID      uuid.UUID
	Name                 string
	AvatarURL            *string
	Status               string
	ModelProvider        *string
	ModelName            *string
	ModelTier            *string
	AuthStatus           *string
	UpstreamState        *string
	UpstreamLastActiveAt time.Time
	CreatedAt            time.Time
}

// DetailUpdate contains fields available only from GET /api/agents/{id}.
type DetailUpdate struct {
	ID            uuid.UUID
	Name          string
	Description   *string
	AvatarURL     *string
	Status        string
	Capabilities  []string
	ModelProvider *string
	ModelName     *string
	UpstreamState *string
}

// Store makes reconciliation independently testable from HTTP and transport.
type Store interface {
	SyncSummaries(context.Context, uuid.UUID, []SummaryUpdate, time.Time) error
	List(context.Context, uuid.UUID, string, *Cursor, int) ([]Agent, error)
	Get(context.Context, uuid.UUID, uuid.UUID) (Agent, error)
	UpdateDetail(context.Context, DetailUpdate, uuid.UUID, time.Time) (Agent, error)
	MarkOffline(context.Context, uuid.UUID, uuid.UUID, time.Time) (Agent, error)
}

var ErrNotFound = errors.New("agent not found")

// PostgresStore persists Berry-owned identity and synchronization state.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

func (store PostgresStore) SyncSummaries(
	ctx context.Context,
	workspaceID uuid.UUID,
	updates []SummaryUpdate,
	now time.Time,
) error {
	if store.Pool == nil {
		return errors.New("agent store pool is nil")
	}
	tx, err := store.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin agent synchronization")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	upstreamIDs := make([]uuid.UUID, 0, len(updates))
	for _, update := range updates {
		if workspaceID == uuid.Nil || update.WorkspaceID != workspaceID {
			return errors.New("agent synchronization workspace is invalid")
		}
		upstreamIDs = append(upstreamIDs, update.OpenFangAgentID)
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO agents (
				id, workspace_id, board_id, openfang_agent_id, name, avatar_url, status,
				model_provider, model_name, model_tier, auth_status,
				upstream_state, upstream_last_active_at, last_synced_at,
				created_at, updated_at, description
			 ) VALUES (
				$1, $2, NULL, $3, $4, $5, $6,
				$7, $8, $9, $10, $11, $12, $13, $14, $13, $15
			 )
			 ON CONFLICT (openfang_agent_id) DO UPDATE SET
				-- A protected agent is authored by Berry, so its name and
				-- description are product content rather than a projection.
				-- Without this carve-out the workspace-scoped upstream name
				-- would overwrite the one users see.
				name = CASE
					WHEN agents.protected THEN agents.name ELSE EXCLUDED.name END,
				-- Same carve-out, and additionally never clears an existing
				-- description with a null: a runtime that stops reporting one
				-- should not erase what the workspace already has.
				description = CASE
					WHEN agents.protected THEN agents.description
					ELSE COALESCE(EXCLUDED.description, agents.description) END,
				avatar_url = EXCLUDED.avatar_url,
				status = EXCLUDED.status,
				model_provider = EXCLUDED.model_provider,
				model_name = EXCLUDED.model_name,
				model_tier = EXCLUDED.model_tier,
				auth_status = EXCLUDED.auth_status,
				upstream_state = EXCLUDED.upstream_state,
				upstream_last_active_at = EXCLUDED.upstream_last_active_at,
				last_synced_at = EXCLUDED.last_synced_at,
				archived_at = NULL,
				updated_at = EXCLUDED.updated_at
			 WHERE agents.workspace_id = EXCLUDED.workspace_id`,
			update.ID,
			update.WorkspaceID,
			update.OpenFangAgentID,
			update.Name,
			update.AvatarURL,
			update.Status,
			update.ModelProvider,
			update.ModelName,
			update.ModelTier,
			update.AuthStatus,
			update.UpstreamState,
			update.UpstreamLastActiveAt,
			now,
			update.CreatedAt,
			update.Description,
		); err != nil {
			return errors.New("upsert runtime agent projection")
		}
	}

	if len(upstreamIDs) == 0 {
		if _, err := tx.Exec(
			ctx,
			`UPDATE agents
			    SET status = 'offline', last_synced_at = $1, updated_at = $1
			  WHERE workspace_id = $2 AND archived_at IS NULL`,
			now,
			workspaceID,
		); err != nil {
			return errors.New("mark unavailable runtime agents")
		}
	} else if _, err := tx.Exec(
		ctx,
		`UPDATE agents
		    SET status = 'offline', last_synced_at = $1, updated_at = $1
		  WHERE archived_at IS NULL
		    AND workspace_id = $2
		    AND NOT (openfang_agent_id = ANY($3::uuid[]))`,
		now,
		workspaceID,
		upstreamIDs,
	); err != nil {
		return errors.New("mark stale runtime agents")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit agent synchronization")
	}
	return nil
}

func (store PostgresStore) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	status string,
	after *Cursor,
	limit int,
) ([]Agent, error) {
	if store.Pool == nil || limit < 1 {
		return nil, errors.New("agent list configuration is invalid")
	}
	afterEnabled := after != nil
	var afterName any
	var afterID any
	if after != nil {
		afterName = after.Name
		afterID = after.ID
	}
	rows, err := store.Pool.Query(
		ctx,
		`SELECT `+agentProjection+`
		   FROM agents
		  WHERE archived_at IS NULL
		    AND workspace_id = $1
		    AND ($2 = '' OR status = $2)
		    AND (NOT $3::boolean OR (name, id) > ($4::text, $5::uuid))
		  ORDER BY name ASC, id ASC
		  LIMIT $6`,
		workspaceID,
		status,
		afterEnabled,
		afterName,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list agents")
	}
	defer rows.Close()
	result := make([]Agent, 0, limit)
	for rows.Next() {
		item, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate agents")
	}
	return result, nil
}

func (store PostgresStore) Get(
	ctx context.Context,
	id, workspaceID uuid.UUID,
) (Agent, error) {
	if store.Pool == nil {
		return Agent{}, errors.New("agent store pool is nil")
	}
	result, err := scanAgent(store.Pool.QueryRow(
		ctx,
		`SELECT `+agentProjection+`
		   FROM agents
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
		id,
		workspaceID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, errors.New("get agent")
	}
	return result, nil
}

func (store PostgresStore) UpdateDetail(
	ctx context.Context,
	update DetailUpdate,
	workspaceID uuid.UUID,
	now time.Time,
) (Agent, error) {
	if store.Pool == nil {
		return Agent{}, errors.New("agent store pool is nil")
	}
	result, err := scanAgent(store.Pool.QueryRow(
		ctx,
		`UPDATE agents
		    SET name = $2,
		        description = $3,
		        avatar_url = $4,
		        status = $5,
		        capabilities = $6,
		        model_provider = $7,
		        model_name = $8,
		        upstream_state = $9,
		        last_synced_at = $10,
		        archived_at = NULL,
		        updated_at = $10
		  WHERE id = $1 AND workspace_id = $11 AND archived_at IS NULL
		  RETURNING `+agentProjection,
		update.ID,
		update.Name,
		update.Description,
		update.AvatarURL,
		update.Status,
		update.Capabilities,
		update.ModelProvider,
		update.ModelName,
		update.UpstreamState,
		now,
		workspaceID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, errors.New("update agent detail")
	}
	return result, nil
}

func (store PostgresStore) MarkOffline(
	ctx context.Context,
	id, workspaceID uuid.UUID,
	now time.Time,
) (Agent, error) {
	if store.Pool == nil {
		return Agent{}, errors.New("agent store pool is nil")
	}
	result, err := scanAgent(store.Pool.QueryRow(
		ctx,
		`UPDATE agents
		    SET status = 'offline', last_synced_at = $2, updated_at = $2
		  WHERE id = $1 AND workspace_id = $3 AND archived_at IS NULL
		  RETURNING `+agentProjection,
		id,
		now,
		workspaceID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Agent{}, ErrNotFound
	}
	if err != nil {
		return Agent{}, errors.New("mark agent offline")
	}
	return result, nil
}

const agentProjection = `
	id, board_id, openfang_agent_id, name, description, avatar_url, status,
	capabilities, instructions, model_provider, model_name, model_tier,
	auth_status, upstream_state, upstream_last_active_at, last_synced_at,
	archived_at, created_at, updated_at`

type agentScanner interface {
	Scan(...any) error
}

func scanAgent(row agentScanner) (Agent, error) {
	var result Agent
	if err := row.Scan(
		&result.ID,
		&result.BoardID,
		&result.OpenFangAgentID,
		&result.Name,
		&result.Description,
		&result.AvatarURL,
		&result.Status,
		&result.Capabilities,
		&result.Instructions,
		&result.ModelProvider,
		&result.ModelName,
		&result.ModelTier,
		&result.AuthStatus,
		&result.UpstreamState,
		&result.UpstreamLastActiveAt,
		&result.LastSyncedAt,
		&result.ArchivedAt,
		&result.CreatedAt,
		&result.UpdatedAt,
	); err != nil {
		return Agent{}, fmt.Errorf("scan agent: %w", err)
	}
	if result.Capabilities == nil {
		result.Capabilities = []string{}
	}
	return result, nil
}
