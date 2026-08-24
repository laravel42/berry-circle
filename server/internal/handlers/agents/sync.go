package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// Lister is the narrow upstream seam sync needs. Kept separate from
// openfang.Runtime so a caller that only reconciles agents cannot dispatch.
//
// GetAgent is here because the list payload carries no description: the field
// exists only on the detail response, so a projection built from the list alone
// can never populate it.
type Lister interface {
	ListAgents(context.Context) ([]openfang.AgentSummary, error)
	GetAgent(context.Context, uuid.UUID) (openfang.AgentDetail, error)
}

// SyncWorkspace reconciles one workspace's agents against the runtime.
//
// Berry does not author agents: OpenFang owns them, and this projects what it
// reports into the product's own identities. Agents absent upstream are marked
// offline rather than deleted, because a Berry agent id is referenced by runs
// and assignment history that must survive the agent going away.
//
// Returns how many updates were offered upstream, not how many landed. Those
// differ: `agents.openfang_agent_id` is globally unique, and the upsert only
// applies within the owning workspace, so a runtime agent already projected
// into another workspace is silently skipped here.
func SyncWorkspace(
	ctx context.Context,
	store Store,
	runtime Lister,
	workspaceID uuid.UUID,
	clock func() time.Time,
	newID func() uuid.UUID,
) (int, error) {
	if store == nil || runtime == nil || workspaceID == uuid.Nil {
		return 0, errors.New("agent sync dependencies are incomplete")
	}
	if clock == nil {
		clock = time.Now
	}
	if newID == nil {
		newID = uuid.New
	}

	summaries, err := runtime.ListAgents(ctx)
	if err != nil {
		return 0, fmt.Errorf("list runtime agents: %w", err)
	}
	now := clock().UTC()
	updates := make([]SummaryUpdate, 0, len(summaries))
	for _, summary := range summaries {
		update, err := projectSummary(summary, workspaceID, newID(), now)
		if err != nil {
			// One malformed agent must not stop the rest from appearing.
			continue
		}
		// Description, capabilities, and the system prompt exist only on the
		// detail response, so each agent costs one extra call. Best effort per
		// agent: an unreachable detail should cost that agent its extra fields,
		// not cost every other agent its whole projection.
		if detail, err := runtime.GetAgent(ctx, summary.ID); err == nil {
			if text := strings.TrimSpace(detail.Description); text != "" &&
				utf8.RuneCountInString(text) <= maxDescription {
				update.Description = &text
			}
			if prompt := strings.TrimSpace(detail.SystemPrompt); prompt != "" &&
				utf8.RuneCountInString(prompt) <= maxInstructions {
				update.Instructions = &prompt
			}
			update.Capabilities = projectCapabilities(detail.Capabilities)
		}
		updates = append(updates, update)
	}
	if err := store.SyncSummaries(ctx, workspaceID, updates, now); err != nil {
		return 0, fmt.Errorf("persist runtime agents: %w", err)
	}
	return len(updates), nil
}

// SyncAllWorkspaces seeds every workspace from the runtime at startup.
//
// Without this, agents only appear once somebody opens the agents page, which
// leaves a fresh deployment with nothing for intake to route to — the built-in
// orchestrator would take every task by fallback even though real agents exist
// upstream.
//
// Never fatal. The runtime being unreachable at boot is a normal condition, and
// the next agents request reconciles anyway; refusing to start would trade a
// stale list for no product at all.
func SyncAllWorkspaces(
	ctx context.Context,
	pool *pgxpool.Pool,
	runtime Lister,
	clock func() time.Time,
	newID func() uuid.UUID,
	logger *slog.Logger,
) {
	if pool == nil || runtime == nil {
		return
	}
	if logger == nil {
		logger = slog.Default()
	}
	rows, err := pool.Query(
		ctx,
		`SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at`,
	)
	if err != nil {
		logger.Warn("agent seed skipped: workspaces unavailable", "error", err)
		return
	}
	var workspaces []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err == nil {
			workspaces = append(workspaces, id)
		}
	}
	rows.Close()
	if rows.Err() != nil {
		logger.Warn("agent seed skipped: workspace read failed", "error", rows.Err())
		return
	}

	store := PostgresStore{Pool: pool}
	for _, workspaceID := range workspaces {
		offered, err := SyncWorkspace(ctx, store, runtime, workspaceID, clock, newID)
		if err != nil {
			logger.Warn("agent seed failed", "workspaceId", workspaceID, "error", err)
			continue
		}
		// Count what the workspace actually holds rather than what was offered.
		// Reporting the offered figure would claim a successful seed for a
		// workspace that received nothing because another already owns those
		// runtime agents.
		var claimed int
		if err := pool.QueryRow(
			ctx,
			`SELECT count(*) FROM agents
			  WHERE workspace_id = $1 AND NOT protected AND archived_at IS NULL`,
			workspaceID,
		).Scan(&claimed); err != nil {
			claimed = -1
		}
		logger.Info(
			"seeded runtime agents",
			"workspaceId", workspaceID,
			"offered", offered,
			"claimed", claimed,
		)
		if offered > 0 && claimed == 0 {
			// Expected under the accepted model rather than a fault: a runtime
			// agent belongs to exactly one workspace, whichever projected it
			// first, so this workspace falls back to its own orchestrator. See
			// "Agent workspace ownership" in docs/integrations/berry-openfang.md.
			logger.Info(
				"workspace has no runtime agents; another workspace owns them",
				"workspaceId", workspaceID,
			)
		}
	}
}

// projectCapabilities flattens the runtime's capability groups into the flat
// list Berry stores, matching how the detail path already does it so a seeded
// agent and a freshly-viewed one cannot disagree about what it can do.
func projectCapabilities(capabilities openfang.AgentCapabilities) []string {
	flat := append([]string(nil), capabilities.Tools...)
	flat = append(flat, capabilities.Network...)
	return sortedCapabilities(flat)
}
