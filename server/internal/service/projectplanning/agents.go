package projectplanning

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AgentLookup finds a usable agent by preference order.
type AgentLookup struct {
	Pool *pgxpool.Pool
}

// FindAgent returns the upstream id of the first preferred agent that can be
// reached, falling back to any usable one.
//
// Preference first so a project decomposes the same way twice, and a fallback
// so a workspace that never created a planner is not simply refused. Offline
// agents are excluded because asking one costs a timeout rather than an answer.
func (lookup AgentLookup) FindAgent(
	ctx context.Context,
	workspaceID uuid.UUID,
	names []string,
) (uuid.UUID, error) {
	if lookup.Pool == nil {
		return uuid.Nil, errors.New("projectplanning: no database pool")
	}
	var upstreamID uuid.UUID
	err := lookup.Pool.QueryRow(
		ctx,
		`SELECT agent.openfang_agent_id
		   FROM agents AS agent
		  WHERE agent.workspace_id = $1
		    AND agent.archived_at IS NULL
		    AND agent.status <> 'offline'
		  ORDER BY
		        -- Preferred names first, in the order given; everything else
		        -- after, so the choice is stable rather than incidental.
		        COALESCE(array_position($2::text[], agent.name), 2147483647),
		        agent.name
		  LIMIT 1`,
		workspaceID, names,
	).Scan(&upstreamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoAgent
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("projectplanning: find agent: %w", err)
	}
	return upstreamID, nil
}

// ProjectLookup resolves a project to its workspace, board and brief.
type ProjectLookup struct {
	Pool *pgxpool.Pool
}

// ProjectContext reads everything the decomposition needs in one query.
//
// The board is the workspace's oldest, which is the one issues are created on
// everywhere else. A workspace with no board cannot receive issues at all, and
// says so rather than failing later at the insert.
func (lookup ProjectLookup) ProjectContext(
	ctx context.Context,
	projectID uuid.UUID,
) (ProjectContext, error) {
	if lookup.Pool == nil {
		return ProjectContext{}, errors.New("projectplanning: no database pool")
	}
	var project ProjectContext
	err := lookup.Pool.QueryRow(
		ctx,
		`SELECT project.workspace_id,
		        board.id,
		        project.name,
		        project.description,
		        project.github_repo_full_name
		   FROM projects AS project
		   JOIN LATERAL (
		       SELECT id FROM boards
		        WHERE workspace_id = project.workspace_id
		        ORDER BY created_at ASC
		        LIMIT 1
		   ) AS board ON TRUE
		  WHERE project.id = $1 AND project.deleted_at IS NULL`,
		projectID,
	).Scan(
		&project.WorkspaceID, &project.BoardID,
		&project.Name, &project.Description, &project.Repository,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProjectContext{}, ErrProjectUnavailable
	}
	if err != nil {
		return ProjectContext{}, fmt.Errorf("projectplanning: read project: %w", err)
	}
	return project, nil
}

// ErrProjectUnavailable means the project is gone, or its workspace has no
// board for issues to live on.
var ErrProjectUnavailable = errors.New("projectplanning: project cannot receive issues")
