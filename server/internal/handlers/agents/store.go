package agents

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/openfang"
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
	Instructions *string
	// Skills are Berry-authored capability names in the planner vocabulary,
	// kept beside the runtime-owned Capabilities which every sync overwrites.
	Skills []string
	// ManifestLimits is the runtime's manifest limit snapshot; nil when the
	// runtime does not report one.
	ManifestLimits       *openfang.AgentLimits
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
	Instructions         *string
	Capabilities         []string
	ManifestLimits       *openfang.AgentLimits
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
				created_at, updated_at, description, capabilities, instructions, manifest_limits
			 ) VALUES (
				$1, $2, NULL, $3, $4, $5, $6,
				$7, $8, $9, $10, $11, $12, $13, $14, $13, $15,
				COALESCE($16::text[], ARRAY[]::text[]), $17, $18::jsonb
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
				-- Capabilities come from the runtime, which owns what an agent
				-- can do. An empty array means "reported none", so it is only
				-- accepted when non-empty — a detail call that failed must not
				-- read as a capability-less agent.
				capabilities = CASE
					WHEN agents.protected THEN agents.capabilities
					WHEN cardinality(EXCLUDED.capabilities) > 0 THEN EXCLUDED.capabilities
					ELSE agents.capabilities END,
				-- Instructions are authored in Berry and pushed upstream, so a
				-- local value is never overwritten by the projection of itself.
				instructions = COALESCE(agents.instructions, EXCLUDED.instructions),
				-- The limit snapshot is refreshed when the runtime reports it and
				-- kept when it does not, so a build that stops exposing it never
				-- erases what was last known.
				manifest_limits = COALESCE(EXCLUDED.manifest_limits, agents.manifest_limits),
				avatar_url = EXCLUDED.avatar_url,
				status = EXCLUDED.status,
				model_provider = EXCLUDED.model_provider,
				model_name = EXCLUDED.model_name,
				model_tier = EXCLUDED.model_tier,
				auth_status = EXCLUDED.auth_status,
				upstream_state = EXCLUDED.upstream_state,
				upstream_last_active_at = EXCLUDED.upstream_last_active_at,
				last_synced_at = EXCLUDED.last_synced_at,
				-- archived_at is deliberately not touched. Sync never archives
				-- an agent — one that vanishes upstream is marked offline so
				-- its runs keep a name — so the only rows carrying a date are
				-- ones somebody removed on purpose. Clearing it here would
				-- resurrect them on the next reconcile, which is what made a
				-- duplicate agent impossible to get rid of.
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
			update.Capabilities,
			update.Instructions,
			encodeLimits(update.ManifestLimits),
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
	archived_at, created_at, updated_at, skills, manifest_limits`

// encodeLimits stores the snapshot as the wire shape the registry returns.
func encodeLimits(limits *openfang.AgentLimits) *string {
	if limits == nil {
		return nil
	}
	encoded, err := json.Marshal(limits)
	if err != nil {
		return nil
	}
	text := string(encoded)
	return &text
}

// RoleAgentIDs lists the runtime agents Berry provisioned for planner roles.
// They are global, not workspace agents, and a sync must never project them.
func (store PostgresStore) RoleAgentIDs(ctx context.Context) ([]uuid.UUID, error) {
	if store.Pool == nil {
		return nil, errors.New("agent store pool is nil")
	}
	rows, err := store.Pool.Query(ctx, `SELECT openfang_agent_id FROM model_role_agents`)
	if err != nil {
		return nil, errors.New("list role agents")
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, errors.New("scan role agent")
		}
		if id, err := uuid.Parse(raw); err == nil {
			ids = append(ids, id)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate role agents")
	}
	return ids, nil
}

// AgentCapability is one registry node: what the agent can do, whether it
// can take work now, and the limits its manifest imposes.
type AgentCapability struct {
	Agent      Agent
	ActiveRuns int
	Protected  bool
}

// ListCapabilities reads every live agent of a workspace with its current
// load, which is what the planner and the capabilities route need in one
// query rather than one per agent.
func (store PostgresStore) ListCapabilities(ctx context.Context, workspaceID uuid.UUID) ([]AgentCapability, error) {
	if store.Pool == nil {
		return nil, errors.New("agent store pool is nil")
	}
	rows, err := store.Pool.Query(
		ctx,
		`SELECT `+agentProjection+`, protected,
		        (SELECT count(*) FROM runs WHERE runs.agent_id = agents.id AND runs.status IN ('queued', 'running'))
		   FROM agents
		  WHERE workspace_id = $1 AND archived_at IS NULL
		  ORDER BY protected ASC, name ASC, id ASC
		  LIMIT 500`,
		workspaceID,
	)
	if err != nil {
		return nil, errors.New("list agent capabilities")
	}
	defer rows.Close()
	result := make([]AgentCapability, 0, 16)
	for rows.Next() {
		var (
			item       AgentCapability
			skills     []string
			limits     []byte
			activeRuns int64
		)
		if err := rows.Scan(
			&item.Agent.ID, &item.Agent.BoardID, &item.Agent.OpenFangAgentID, &item.Agent.Name, &item.Agent.Description, &item.Agent.AvatarURL,
			&item.Agent.Status, &item.Agent.Capabilities, &item.Agent.Instructions, &item.Agent.ModelProvider, &item.Agent.ModelName,
			&item.Agent.ModelTier, &item.Agent.AuthStatus, &item.Agent.UpstreamState, &item.Agent.UpstreamLastActiveAt, &item.Agent.LastSyncedAt,
			&item.Agent.ArchivedAt, &item.Agent.CreatedAt, &item.Agent.UpdatedAt, &skills, &limits, &item.Protected, &activeRuns,
		); err != nil {
			return nil, fmt.Errorf("scan agent capability: %w", err)
		}
		item.Agent.Skills = skills
		item.Agent.ManifestLimits = decodeLimits(limits)
		item.ActiveRuns = int(activeRuns)
		if item.Agent.Capabilities == nil {
			item.Agent.Capabilities = []string{}
		}
		if item.Agent.Skills == nil {
			item.Agent.Skills = []string{}
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate agent capabilities")
	}
	return result, nil
}

func decodeLimits(raw []byte) *openfang.AgentLimits {
	if len(raw) == 0 {
		return nil
	}
	var limits openfang.AgentLimits
	if json.Unmarshal(raw, &limits) != nil || (limits.MaxTokens == nil && limits.MaxLLMTokensPerHour == nil) {
		return nil
	}
	return &limits
}

type agentScanner interface {
	Scan(...any) error
}

func scanAgent(row agentScanner) (Agent, error) {
	var (
		result Agent
		skills []string
		limits []byte
	)
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
		&skills,
		&limits,
	); err != nil {
		return Agent{}, fmt.Errorf("scan agent: %w", err)
	}
	if result.Capabilities == nil {
		result.Capabilities = []string{}
	}
	result.Skills = skills
	if result.Skills == nil {
		result.Skills = []string{}
	}
	result.ManifestLimits = decodeLimits(limits)
	return result, nil
}
