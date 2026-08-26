package modelgateway

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Role agent statuses, mirroring model_role_agents_status_ck.
const (
	StatusAvailable = "available"
	StatusOffline   = "offline"
	StatusUnknown   = "unknown"
)

// ErrNotFound means no agent is recorded for the role.
var ErrNotFound = errors.New("model role agent not found")

// RoleAgent is one provisioned role: which runtime agent answers for it, on
// which provider and model, with which prompt, and the limits its manifest
// carried when it was spawned or last read back.
type RoleAgent struct {
	Role                Role
	OpenFangAgentID     uuid.UUID
	UpstreamName        string
	Provider            string
	Model               string
	PromptVersion       string
	MaxTokens           *int64
	MaxLLMTokensPerHour *int64
	Status              string
	LastSyncedAt        *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// Store persists role agents. Global by design: one row per role serves
// every workspace (D8 exemption).
type Store interface {
	RoleReader
	Upsert(ctx context.Context, agent RoleAgent, now time.Time) error
	SetStatus(ctx context.Context, role Role, status string, now time.Time) error
}

// PostgresStore is the model_role_agents table.
type PostgresStore struct {
	Pool *pgxpool.Pool
}

// NewStore validates the pool.
func NewStore(pool *pgxpool.Pool) (*PostgresStore, error) {
	if pool == nil {
		return nil, errors.New("model role store pool is nil")
	}
	return &PostgresStore{Pool: pool}, nil
}

const roleProjection = `role, openfang_agent_id, upstream_name, model_provider, model_name, prompt_version,
	max_tokens, max_llm_tokens_per_hour, status, last_synced_at, created_at, updated_at`

type roleScanner interface {
	Scan(...any) error
}

func scanRoleAgent(row roleScanner) (RoleAgent, error) {
	var (
		agent RoleAgent
		role  string
		id    string
	)
	if err := row.Scan(
		&role, &id, &agent.UpstreamName, &agent.Provider, &agent.Model, &agent.PromptVersion,
		&agent.MaxTokens, &agent.MaxLLMTokensPerHour, &agent.Status, &agent.LastSyncedAt, &agent.CreatedAt, &agent.UpdatedAt,
	); err != nil {
		return RoleAgent{}, err
	}
	agent.Role = Role(role)
	parsed, err := uuid.Parse(id)
	if err != nil {
		return RoleAgent{}, errors.New("role agent id is not a UUID")
	}
	agent.OpenFangAgentID = parsed
	return agent, nil
}

// Get returns one role.
func (store *PostgresStore) Get(ctx context.Context, role Role) (RoleAgent, error) {
	if store == nil || store.Pool == nil {
		return RoleAgent{}, errors.New("model role store pool is nil")
	}
	agent, err := scanRoleAgent(store.Pool.QueryRow(ctx, `SELECT `+roleProjection+` FROM model_role_agents WHERE role = $1`, string(role)))
	if errors.Is(err, pgx.ErrNoRows) {
		return RoleAgent{}, ErrNotFound
	}
	if err != nil {
		return RoleAgent{}, errors.New("get model role agent")
	}
	return agent, nil
}

// List returns every role in provisioning order.
func (store *PostgresStore) List(ctx context.Context) ([]RoleAgent, error) {
	if store == nil || store.Pool == nil {
		return nil, errors.New("model role store pool is nil")
	}
	rows, err := store.Pool.Query(ctx, `SELECT `+roleProjection+` FROM model_role_agents ORDER BY role`)
	if err != nil {
		return nil, errors.New("list model role agents")
	}
	defer rows.Close()
	byRole := map[Role]RoleAgent{}
	for rows.Next() {
		agent, err := scanRoleAgent(rows)
		if err != nil {
			return nil, errors.New("scan model role agent")
		}
		byRole[agent.Role] = agent
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate model role agents")
	}
	out := make([]RoleAgent, 0, len(byRole))
	for _, role := range Roles {
		if agent, ok := byRole[role]; ok {
			out = append(out, agent)
		}
	}
	return out, nil
}

// Upsert records a provisioned role, replacing any earlier agent for it.
func (store *PostgresStore) Upsert(ctx context.Context, agent RoleAgent, now time.Time) error {
	if store == nil || store.Pool == nil {
		return errors.New("model role store pool is nil")
	}
	if !agent.Role.Valid() || agent.OpenFangAgentID == uuid.Nil || agent.UpstreamName == "" ||
		agent.Provider == "" || agent.Model == "" || agent.PromptVersion == "" {
		return errors.New("model role agent is incomplete")
	}
	status := agent.Status
	if status == "" {
		status = StatusUnknown
	}
	if _, err := store.Pool.Exec(
		ctx,
		`INSERT INTO model_role_agents (
		    role, openfang_agent_id, upstream_name, model_provider, model_name, prompt_version,
		    max_tokens, max_llm_tokens_per_hour, status, last_synced_at, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10)
		 ON CONFLICT (role) DO UPDATE SET
		    openfang_agent_id = EXCLUDED.openfang_agent_id,
		    upstream_name = EXCLUDED.upstream_name,
		    model_provider = EXCLUDED.model_provider,
		    model_name = EXCLUDED.model_name,
		    prompt_version = EXCLUDED.prompt_version,
		    max_tokens = EXCLUDED.max_tokens,
		    max_llm_tokens_per_hour = EXCLUDED.max_llm_tokens_per_hour,
		    status = EXCLUDED.status,
		    last_synced_at = EXCLUDED.last_synced_at,
		    updated_at = EXCLUDED.updated_at`,
		string(agent.Role), agent.OpenFangAgentID.String(), agent.UpstreamName, agent.Provider, agent.Model, agent.PromptVersion,
		agent.MaxTokens, agent.MaxLLMTokensPerHour, status, now.UTC(),
	); err != nil {
		return errors.New("upsert model role agent")
	}
	return nil
}

// SetStatus records whether the role answers.
func (store *PostgresStore) SetStatus(ctx context.Context, role Role, status string, now time.Time) error {
	if store == nil || store.Pool == nil {
		return errors.New("model role store pool is nil")
	}
	tag, err := store.Pool.Exec(
		ctx,
		`UPDATE model_role_agents SET status = $2, last_synced_at = $3, updated_at = $3 WHERE role = $1`,
		string(role), status, now.UTC(),
	)
	if err != nil {
		return errors.New("update model role agent status")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

var _ Store = (*PostgresStore)(nil)
