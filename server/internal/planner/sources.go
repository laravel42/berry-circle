package planner

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
)

// PostgresSources reads the workspace facts the context stage and the
// validator need. Every query is bounded and reads projections only: no
// prompts, no credentials, no issue bodies.
type PostgresSources struct {
	Pool *pgxpool.Pool
}

// Workspace implements WorkspaceSource.
func (sources PostgresSources) Workspace(ctx context.Context, workspaceID uuid.UUID) (WorkspaceData, error) {
	if sources.Pool == nil {
		return WorkspaceData{}, errors.New("planner sources pool is nil")
	}
	data := WorkspaceData{ID: workspaceID, Boards: map[uuid.UUID]bool{}, Projects: map[uuid.UUID]bool{}, Members: map[uuid.UUID]bool{}}
	if err := sources.Pool.QueryRow(
		ctx,
		`SELECT name, COALESCE(settings->>'issuePrefix', '') FROM workspaces WHERE id = $1 AND deleted_at IS NULL`,
		workspaceID,
	).Scan(&data.Name, &data.IssuePrefix); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WorkspaceData{}, errors.New("workspace not found")
		}
		return WorkspaceData{}, errors.New("read workspace")
	}
	for _, query := range []struct {
		sql string
		set map[uuid.UUID]bool
	}{
		{`SELECT id FROM boards WHERE workspace_id = $1`, data.Boards},
		{`SELECT id FROM projects WHERE workspace_id = $1 AND deleted_at IS NULL`, data.Projects},
		{`SELECT user_id FROM workspace_memberships WHERE workspace_id = $1`, data.Members},
	} {
		rows, err := sources.Pool.Query(ctx, query.sql, workspaceID)
		if err != nil {
			return WorkspaceData{}, errors.New("read workspace scope")
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return WorkspaceData{}, errors.New("scan workspace scope")
			}
			query.set[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return WorkspaceData{}, errors.New("iterate workspace scope")
		}
	}
	return data, nil
}

// Agents implements AgentSource: every live agent with its Berry-authored
// skills, runtime tools, status, active runs and manifest limits.
func (sources PostgresSources) Agents(ctx context.Context, workspaceID uuid.UUID) ([]validate.Agent, error) {
	if sources.Pool == nil {
		return nil, errors.New("planner sources pool is nil")
	}
	rows, err := sources.Pool.Query(
		ctx,
		`SELECT agent.id, agent.name, agent.status, agent.capabilities, agent.skills, agent.manifest_limits, agent.model_tier, agent.protected,
		        (SELECT count(*) FROM runs WHERE runs.agent_id = agent.id AND runs.status IN ('queued', 'running'))
		   FROM agents AS agent
		  WHERE agent.workspace_id = $1 AND agent.archived_at IS NULL
		  ORDER BY agent.protected ASC, agent.name ASC, agent.id ASC
		  LIMIT 500`,
		workspaceID,
	)
	if err != nil {
		return nil, errors.New("list planner agents")
	}
	defer rows.Close()
	agents := []validate.Agent{}
	for rows.Next() {
		var (
			agent      validate.Agent
			tools      []string
			skills     []string
			limits     []byte
			tier       *string
			activeRuns int64
		)
		if err := rows.Scan(&agent.ID, &agent.Name, &agent.Status, &tools, &skills, &limits, &tier, &agent.Orchestrator, &activeRuns); err != nil {
			return nil, errors.New("scan planner agent")
		}
		agent.Tools, agent.Skills, agent.ActiveRuns = tools, skills, int(activeRuns)
		if tier != nil {
			agent.CostTier = *tier
		}
		if len(limits) > 0 {
			var parsed openfang.AgentLimits
			if json.Unmarshal(limits, &parsed) == nil {
				agent.MaxTokens, agent.MaxLLMTokensPerHour = parsed.MaxTokens, parsed.MaxLLMTokensPerHour
			}
		}
		agents = append(agents, agent)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate planner agents")
	}
	return agents, nil
}

// OpenIssues implements IssueSource.
func (sources PostgresSources) OpenIssues(ctx context.Context, workspaceID uuid.UUID, limit int) ([]validate.ExistingIssue, error) {
	if sources.Pool == nil {
		return nil, errors.New("planner sources pool is nil")
	}
	if limit < 1 {
		limit = MaxOpenIssuesRead
	}
	rows, err := sources.Pool.Query(
		ctx,
		`SELECT issue.id, berry_issue_identifier(board.workspace_id, issue.number), issue.title, issue.status::text
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		  WHERE board.workspace_id = $1 AND issue.deleted_at IS NULL AND issue.status NOT IN ('done', 'cancelled')
		  ORDER BY issue.updated_at DESC, issue.id DESC
		  LIMIT $2`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, errors.New("list open issues")
	}
	defer rows.Close()
	issues := []validate.ExistingIssue{}
	for rows.Next() {
		var issue validate.ExistingIssue
		if err := rows.Scan(&issue.ID, &issue.Identifier, &issue.Title, &issue.Status); err != nil {
			return nil, errors.New("scan open issue")
		}
		issues = append(issues, issue)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate open issues")
	}
	return issues, nil
}

// Workflows implements WorkflowSource: live automations with their trigger
// and the provider actions their definition calls.
func (sources PostgresSources) Workflows(ctx context.Context, workspaceID uuid.UUID) ([]validate.ExistingWorkflow, error) {
	if sources.Pool == nil {
		return nil, errors.New("planner sources pool is nil")
	}
	rows, err := sources.Pool.Query(
		ctx,
		`SELECT id, name, status, trigger_type, COALESCE(trigger_provider, ''), COALESCE(trigger_operation, ''), COALESCE(trigger_event, ''), definition
		   FROM automations
		  WHERE workspace_id = $1 AND archived_at IS NULL
		  ORDER BY updated_at DESC, id DESC
		  LIMIT 200`,
		workspaceID,
	)
	if err != nil {
		return nil, errors.New("list workflows")
	}
	defer rows.Close()
	workflows := []validate.ExistingWorkflow{}
	for rows.Next() {
		var (
			workflow   validate.ExistingWorkflow
			definition []byte
		)
		if err := rows.Scan(&workflow.ID, &workflow.Name, &workflow.Status, &workflow.TriggerType, &workflow.TriggerProvider,
			&workflow.TriggerOperation, &workflow.TriggerEvent, &definition); err != nil {
			return nil, errors.New("scan workflow")
		}
		workflow.Actions = []string{}
		if parsed, findings := automation.ParseDefinition(definition); len(findings) == 0 {
			for _, step := range parsed.Steps {
				if step.Action != nil {
					workflow.Actions = append(workflow.Actions, step.Action.Provider+"."+step.Action.Operation)
				}
			}
		}
		workflows = append(workflows, workflow)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate workflows")
	}
	return workflows, nil
}

// OpenGoals implements GoalSource.
func (sources PostgresSources) OpenGoals(ctx context.Context, workspaceID uuid.UUID, limit int) ([]GoalSummary, error) {
	if sources.Pool == nil {
		return nil, errors.New("planner sources pool is nil")
	}
	if limit < 1 {
		limit = MaxContextGoals
	}
	rows, err := sources.Pool.Query(
		ctx,
		`SELECT id, title FROM goals
		  WHERE workspace_id = $1 AND deleted_at IS NULL AND status IN ('draft', 'planned', 'active', 'blocked')
		  ORDER BY updated_at DESC, id DESC
		  LIMIT $2`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, errors.New("list open goals")
	}
	defer rows.Close()
	goals := []GoalSummary{}
	for rows.Next() {
		var goal GoalSummary
		if err := rows.Scan(&goal.ID, &goal.Title); err != nil {
			return nil, errors.New("scan open goal")
		}
		goals = append(goals, goal)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate open goals")
	}
	return goals, nil
}

// Project implements ProjectSource.
func (sources PostgresSources) Project(ctx context.Context, workspaceID, projectID uuid.UUID) (ProjectData, error) {
	if sources.Pool == nil {
		return ProjectData{}, errors.New("planner sources pool is nil")
	}
	var project ProjectData
	err := sources.Pool.QueryRow(
		ctx,
		`SELECT id, name, COALESCE(description, ''), COALESCE(github_repo_full_name, '')
		   FROM projects WHERE id = $2 AND workspace_id = $1 AND deleted_at IS NULL`,
		workspaceID, projectID,
	).Scan(&project.ID, &project.Name, &project.Description, &project.Repository)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProjectData{}, errors.New("project not found")
	}
	if err != nil {
		return ProjectData{}, errors.New("read project")
	}
	return project, nil
}

var (
	_ WorkspaceSource = PostgresSources{}
	_ AgentSource     = PostgresSources{}
	_ IssueSource     = PostgresSources{}
	_ WorkflowSource  = PostgresSources{}
	_ GoalSource      = PostgresSources{}
	_ ProjectSource   = PostgresSources{}
)
