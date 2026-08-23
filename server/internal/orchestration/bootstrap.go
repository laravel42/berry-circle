package orchestration

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// OrchestratorSpec describes the model the built-in orchestrator runs on.
// Provider and model are deployment choices — Berry does not pick an LLM for
// an operator — so provisioning is skipped when they are unset.
type OrchestratorSpec struct {
	Provider string
	Model    string
}

// Configured reports whether the deployment supplied enough to provision.
func (spec OrchestratorSpec) Configured() bool {
	return strings.TrimSpace(spec.Provider) != "" &&
		strings.TrimSpace(spec.Model) != ""
}

// protectedAgent is one workspace's built-in orchestrator row.
type protectedAgent struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Upstream    uuid.UUID
	Name        string
	Status      string
}

// EnsureOrchestrators makes every workspace's protected agent executable.
//
// Migration 009 guarantees the row exists; it cannot guarantee the agent
// exists in OpenFang, which is a separate system with its own store. This
// reconciles the two: for each protected agent whose recorded upstream id is
// absent, it spawns one and records the result.
//
// Ordering matters. POST /api/agents is an unsafe create with no idempotency
// key, so a lost response would orphan an upstream agent. The absence check
// runs first, the spawn happens once, and the new id is written immediately —
// a crash between spawn and write leaks one upstream agent, which is
// recoverable, whereas skipping the check would duplicate on every boot.
//
// Failure here is never fatal. An orchestrator that cannot be provisioned
// stays `offline` and is simply not selected by intake, which is visible and
// safe; refusing to start the worker over it would take down run dispatch for
// every already-working agent.
func EnsureOrchestrators(
	ctx context.Context,
	pool *pgxpool.Pool,
	provisioner openfang.Provisioner,
	spec OrchestratorSpec,
	logger *slog.Logger,
) error {
	if pool == nil {
		return errors.New("orchestrator bootstrap pool is nil")
	}
	if provisioner == nil {
		return errors.New("orchestrator bootstrap provisioner is nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if !spec.Configured() {
		logger.Warn(
			"orchestrator provisioning skipped: set ORCHESTRATOR_PROVIDER and " +
				"ORCHESTRATOR_MODEL to let the built-in agent take intake work",
		)
		return nil
	}

	agents, err := loadProtectedAgents(ctx, pool)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if err := ensureOne(ctx, pool, provisioner, spec, agent, logger); err != nil {
			// One workspace failing must not stop the others.
			logger.Warn(
				"orchestrator provisioning failed",
				"workspaceId", agent.WorkspaceID,
				"agentId", agent.ID,
				"error", err,
			)
		}
	}
	return nil
}

func loadProtectedAgents(
	ctx context.Context,
	pool *pgxpool.Pool,
) ([]protectedAgent, error) {
	rows, err := pool.Query(
		ctx,
		`SELECT id, workspace_id, openfang_agent_id, name, status
		   FROM agents
		  WHERE protected AND archived_at IS NULL AND workspace_id IS NOT NULL
		  ORDER BY workspace_id`,
	)
	if err != nil {
		return nil, errors.New("load protected agents")
	}
	defer rows.Close()

	var agents []protectedAgent
	for rows.Next() {
		var agent protectedAgent
		if err := rows.Scan(
			&agent.ID,
			&agent.WorkspaceID,
			&agent.Upstream,
			&agent.Name,
			&agent.Status,
		); err != nil {
			return nil, errors.New("scan protected agent")
		}
		agents = append(agents, agent)
	}
	if rows.Err() != nil {
		return nil, errors.New("read protected agents")
	}
	return agents, nil
}

func ensureOne(
	ctx context.Context,
	pool *pgxpool.Pool,
	provisioner openfang.Provisioner,
	spec OrchestratorSpec,
	agent protectedAgent,
	logger *slog.Logger,
) error {
	// Already provisioned: the recorded upstream agent answers.
	if _, err := provisioner.GetAgent(ctx, agent.Upstream); err == nil {
		return markAvailable(ctx, pool, agent.ID, agent.Upstream)
	} else if !isMissingUpstream(err) {
		// A transport or auth failure is not proof of absence, and spawning on
		// that assumption would duplicate the agent on every restart.
		return fmt.Errorf("probe orchestrator agent: %w", err)
	}

	spawned, err := provisioner.SpawnAgent(ctx, orchestratorManifest(agent.Name, spec))
	if err != nil {
		return fmt.Errorf("spawn orchestrator agent: %w", err)
	}
	if err := markAvailable(ctx, pool, agent.ID, spawned.AgentID); err != nil {
		return err
	}
	logger.Info(
		"orchestrator provisioned",
		"workspaceId", agent.WorkspaceID,
		"agentId", agent.ID,
		"upstreamAgentId", spawned.AgentID,
	)
	return nil
}

// markAvailable records the confirmed upstream identity. Status becomes
// `available` only here, so the row never claims to be executable before
// OpenFang has confirmed it is.
func markAvailable(
	ctx context.Context,
	pool *pgxpool.Pool,
	agentID, upstreamID uuid.UUID,
) error {
	if _, err := pool.Exec(
		ctx,
		`UPDATE agents
		    SET openfang_agent_id = $2,
		        status = 'available',
		        last_synced_at = now(),
		        updated_at = now()
		  WHERE id = $1 AND protected`,
		agentID,
		upstreamID,
	); err != nil {
		return errors.New("record orchestrator provisioning")
	}
	return nil
}

// isMissingUpstream distinguishes "this agent does not exist" from every other
// failure. Only a definitive 404 authorises a spawn.
func isMissingUpstream(err error) bool {
	var upstream *openfang.UpstreamError
	if errors.As(err, &upstream) {
		return upstream.Kind == openfang.ErrorNotFound
	}
	return false
}

// orchestratorManifest builds the TOML the runtime expects. Kept minimal on
// purpose: execution-side configuration belongs to OpenFang, and Berry should
// not accumulate opinions about prompts or tools here.
func orchestratorManifest(name string, spec OrchestratorSpec) string {
	var builder strings.Builder
	builder.WriteString("name = \"")
	builder.WriteString(tomlEscape(name))
	builder.WriteString("\"\n")
	builder.WriteString("description = \"Berry built-in orchestrator.\"\n")
	builder.WriteString("[model]\n")
	builder.WriteString("provider = \"")
	builder.WriteString(tomlEscape(strings.TrimSpace(spec.Provider)))
	builder.WriteString("\"\n")
	builder.WriteString("model = \"")
	builder.WriteString(tomlEscape(strings.TrimSpace(spec.Model)))
	builder.WriteString("\"\n")
	return builder.String()
}

func tomlEscape(value string) string {
	replacer := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"\n", `\n`,
		"\r", `\r`,
		"\t", `\t`,
	)
	return replacer.Replace(value)
}
