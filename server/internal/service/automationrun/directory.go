package automationrun

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrAgentNotFound means no usable agent matched.
	ErrAgentNotFound = errors.New("agent not found")
	// ErrBoardNotFound means the workspace has no such board.
	ErrBoardNotFound = errors.New("board not found")
)

// Directory resolves agents and boards straight from PostgreSQL. It is the
// default AgentDirectory and BoardDirectory.
type Directory struct {
	Pool *pgxpool.Pool
}

// Agent returns a live agent of the workspace by id.
func (directory Directory) Agent(ctx context.Context, workspaceID, agentID uuid.UUID) (AgentRef, error) {
	if directory.Pool == nil {
		return AgentRef{}, errors.New("automationrun: no database pool")
	}
	var agent AgentRef
	err := directory.Pool.QueryRow(
		ctx,
		`SELECT id, openfang_agent_id, name FROM agents
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
		agentID, workspaceID,
	).Scan(&agent.ID, &agent.UpstreamID, &agent.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentRef{}, ErrAgentNotFound
	}
	if err != nil {
		return AgentRef{}, errors.New("automationrun: resolve agent")
	}
	return agent, nil
}

// FindByCapabilities picks the agent whose declared skills or capabilities
// overlap the requirement most, available agents first, then by name so
// the choice is stable.
func (directory Directory) FindByCapabilities(ctx context.Context, workspaceID uuid.UUID, capabilities []string) (AgentRef, error) {
	if directory.Pool == nil {
		return AgentRef{}, errors.New("automationrun: no database pool")
	}
	if len(capabilities) == 0 {
		return AgentRef{}, ErrAgentNotFound
	}
	var agent AgentRef
	err := directory.Pool.QueryRow(
		ctx,
		`SELECT agent.id, agent.openfang_agent_id, agent.name
		   FROM agents AS agent
		  WHERE agent.workspace_id = $1
		    AND agent.archived_at IS NULL
		    AND agent.status <> 'offline'
		    AND (agent.skills && $2::text[] OR agent.capabilities && $2::text[])
		  ORDER BY
		        (SELECT count(*) FROM unnest($2::text[]) AS wanted
		          WHERE wanted = ANY(agent.skills) OR wanted = ANY(agent.capabilities)) DESC,
		        (agent.status = 'available') DESC,
		        agent.name ASC, agent.id ASC
		  LIMIT 1`,
		workspaceID, capabilities,
	).Scan(&agent.ID, &agent.UpstreamID, &agent.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentRef{}, ErrAgentNotFound
	}
	if err != nil {
		return AgentRef{}, errors.New("automationrun: find agent by capability")
	}
	return agent, nil
}

// DefaultBoard is the workspace's oldest board, the one every other issue
// writer falls back to.
func (directory Directory) DefaultBoard(ctx context.Context, workspaceID uuid.UUID) (uuid.UUID, error) {
	if directory.Pool == nil {
		return uuid.Nil, errors.New("automationrun: no database pool")
	}
	var boardID uuid.UUID
	err := directory.Pool.QueryRow(
		ctx,
		`SELECT id FROM boards WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
		workspaceID,
	).Scan(&boardID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrBoardNotFound
	}
	if err != nil {
		return uuid.Nil, errors.New("automationrun: resolve default board")
	}
	return boardID, nil
}

// BoardWorkspace returns the workspace a board belongs to.
func (directory Directory) BoardWorkspace(ctx context.Context, boardID uuid.UUID) (uuid.UUID, error) {
	if directory.Pool == nil {
		return uuid.Nil, errors.New("automationrun: no database pool")
	}
	var workspaceID uuid.UUID
	err := directory.Pool.QueryRow(ctx, `SELECT workspace_id FROM boards WHERE id = $1`, boardID).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrBoardNotFound
	}
	if err != nil {
		return uuid.Nil, errors.New("automationrun: resolve board workspace")
	}
	return workspaceID, nil
}
