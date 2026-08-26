package identity

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// BoardScope resolves an active membership without distinguishing a missing
// board from a board in another workspace.
func (repository *Repository) BoardScope(
	ctx context.Context,
	userID, boardID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, membership.role::text
		   FROM boards AS board
		   JOIN workspaces AS workspace
		     ON workspace.id = board.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE board.id = $2`,
		userID,
		boardID,
	))
}

// IssueScope resolves an issue's board workspace through active membership.
func (repository *Repository) IssueScope(
	ctx context.Context,
	userID, issueID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, membership.role::text
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		    AND issue.deleted_at IS NULL
		   JOIN workspaces AS workspace
		     ON workspace.id = board.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE issue.id = $2`,
		userID,
		issueID,
	))
}

// IssueReferenceScope resolves either a canonical issue UUID or PREFIX-N
// identifier without exposing whether an inaccessible issue exists.
func (repository *Repository) IssueReferenceScope(
	ctx context.Context,
	userID uuid.UUID,
	reference string,
) (Scope, error) {
	if issueID, err := uuid.Parse(reference); err == nil &&
		issueID != uuid.Nil && issueID.String() == reference {
		return repository.IssueScope(ctx, userID, issueID)
	}
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, membership.role::text
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		    AND issue.deleted_at IS NULL
		   JOIN workspaces AS workspace
		     ON workspace.id = board.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE lower(workspace.settings->>'issuePrefix') || '-' || issue.number::text = lower($2)`,
		userID,
		reference,
	))
}

// CommentScope resolves a comment through its issue and board.
func (repository *Repository) CommentScope(
	ctx context.Context,
	userID, commentID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, membership.role::text
		   FROM comments AS comment
		   JOIN issues AS issue ON issue.id = comment.issue_id
		   JOIN boards AS board ON board.id = issue.board_id
		   JOIN workspaces AS workspace
		     ON workspace.id = board.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE comment.id = $2`,
		userID,
		commentID,
	))
}

// RunScope resolves a durable run through its denormalized owning board.
func (repository *Repository) RunScope(
	ctx context.Context,
	userID, runID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT board.workspace_id, membership.role::text
		   FROM runs AS run
		   JOIN boards AS board ON board.id = run.board_id
		   JOIN workspaces AS workspace
		     ON workspace.id = board.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE run.id = $2`,
		userID,
		runID,
	))
}

// AgentScope resolves workspace-owned agent projections. Compatibility agents
// without a workspace remain invisible until their parent lane attributes them.
func (repository *Repository) AgentScope(
	ctx context.Context,
	userID, agentID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT workspace.id, membership.role::text
		   FROM agents AS agent
		   LEFT JOIN boards AS board ON board.id = agent.board_id
		   JOIN workspaces AS workspace
		     ON workspace.id = COALESCE(agent.workspace_id, board.workspace_id)
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE agent.id = $2`,
		userID,
		agentID,
	))
}

// AssigneeExistsInWorkspace prevents assignment payloads from linking users or
// agents owned by another workspace.
func (repository *Repository) AssigneeExistsInWorkspace(
	ctx context.Context,
	workspaceID uuid.UUID,
	actorType string,
	actorID uuid.UUID,
) (bool, error) {
	var exists bool
	var err error
	switch actorType {
	case "user":
		err = repository.Pool.QueryRow(
			ctx,
			`SELECT EXISTS (
				SELECT 1
				  FROM workspace_memberships AS membership
				  JOIN workspaces AS workspace
				    ON workspace.id = membership.workspace_id
				   AND workspace.deleted_at IS NULL
				 WHERE membership.workspace_id = $1
				   AND membership.user_id = $2
			)`,
			workspaceID,
			actorID,
		).Scan(&exists)
	case "agent":
		err = repository.Pool.QueryRow(
			ctx,
			`SELECT EXISTS (
				SELECT 1
				  FROM agents AS agent
				  LEFT JOIN boards AS board ON board.id = agent.board_id
				 WHERE agent.id = $2
				   AND agent.archived_at IS NULL
				   AND COALESCE(agent.workspace_id, board.workspace_id) = $1
			)`,
			workspaceID,
			actorID,
		).Scan(&exists)
	default:
		return false, nil
	}
	if err != nil {
		return false, errors.New("validate product assignee workspace")
	}
	return exists, nil
}

func scanScope(row scanner) (Scope, error) {
	var (
		scope Scope
		role  string
	)
	if err := row.Scan(&scope.WorkspaceID, &role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Scope{}, ErrNotFound
		}
		return Scope{}, errors.New("resolve product resource workspace")
	}
	scope.Role = Role(role)
	return scope, nil
}

// GoalScope resolves a live goal's workspace through active membership.
// Archived goals are hidden the same way deleted issues are.
func (repository *Repository) GoalScope(
	ctx context.Context,
	userID, goalID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT goal.workspace_id, membership.role::text
		   FROM goals AS goal
		   JOIN workspaces AS workspace
		     ON workspace.id = goal.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE goal.id = $2 AND goal.deleted_at IS NULL`,
		userID,
		goalID,
	))
}

// PlanScope resolves a plan's workspace through active membership. Briefs and
// generated plans share the table, so both resolve here.
func (repository *Repository) PlanScope(
	ctx context.Context,
	userID, planID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT plan.workspace_id, membership.role::text
		   FROM plans AS plan
		   JOIN workspaces AS workspace
		     ON workspace.id = plan.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE plan.id = $2`,
		userID,
		planID,
	))
}

// ApprovalScope resolves an approval's workspace through active membership.
func (repository *Repository) ApprovalScope(
	ctx context.Context,
	userID, approvalID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT approval.workspace_id, membership.role::text
		   FROM approvals AS approval
		   JOIN workspaces AS workspace
		     ON workspace.id = approval.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE approval.id = $2`,
		userID,
		approvalID,
	))
}

// AutomationScope resolves a workflow's workspace through active membership.
// Archived workflows stay resolvable: their run history is still readable.
func (repository *Repository) AutomationScope(
	ctx context.Context,
	userID, automationID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT automation.workspace_id, membership.role::text
		   FROM automations AS automation
		   JOIN workspaces AS workspace
		     ON workspace.id = automation.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE automation.id = $2`,
		userID,
		automationID,
	))
}

// AutomationRunScope resolves a workflow run's workspace through active
// membership.
func (repository *Repository) AutomationRunScope(
	ctx context.Context,
	userID, runID uuid.UUID,
) (Scope, error) {
	return scanScope(repository.Pool.QueryRow(
		ctx,
		`SELECT run.workspace_id, membership.role::text
		   FROM automation_runs AS run
		   JOIN workspaces AS workspace
		     ON workspace.id = run.workspace_id
		    AND workspace.deleted_at IS NULL
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = workspace.id
		    AND membership.user_id = $1
		  WHERE run.id = $2`,
		userID,
		runID,
	))
}
