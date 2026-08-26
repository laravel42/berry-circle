package core

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// GoalRef names the goal an issue serves.
type GoalRef struct {
	ID    uuid.UUID `json:"id"`
	Title string    `json:"title"`
}

// IssueOrigin records the workflow run that created an issue.
type IssueOrigin struct {
	WorkflowID        uuid.UUID  `json:"workflowId"`
	WorkflowRunID     uuid.UUID  `json:"workflowRunId"`
	WorkflowStepRunID *uuid.UUID `json:"workflowStepRunId"`
}

// IssueRelations is what the issue resource carries beside its own row: the
// goal link, the automation origin and both dependency directions.
type IssueRelations struct {
	Goal      *GoalRef
	Origin    *IssueOrigin
	DependsOn []IssueDependencyRef
	Blocks    []IssueDependencyRef
}

type relationQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

// LoadIssueRelations reads the relations of many issues in three queries so
// a list page never pays one round trip per row. Every requested id has an
// entry; absent relations are empty, never nil slices.
func LoadIssueRelations(ctx context.Context, querier relationQuerier, issueIDs []uuid.UUID) (map[uuid.UUID]IssueRelations, error) {
	result := make(map[uuid.UUID]IssueRelations, len(issueIDs))
	for _, id := range issueIDs {
		result[id] = IssueRelations{DependsOn: []IssueDependencyRef{}, Blocks: []IssueDependencyRef{}}
	}
	if len(issueIDs) == 0 {
		return result, nil
	}
	rows, err := querier.Query(
		ctx,
		`SELECT link.issue_id, goal.id, goal.title
		   FROM goal_issues AS link
		   JOIN goals AS goal ON goal.id = link.goal_id AND goal.deleted_at IS NULL
		  WHERE link.issue_id = ANY($1::uuid[])`,
		issueIDs,
	)
	if err != nil {
		return nil, errors.New("load issue goals")
	}
	for rows.Next() {
		var (
			issueID uuid.UUID
			goal    GoalRef
		)
		if err := rows.Scan(&issueID, &goal.ID, &goal.Title); err != nil {
			rows.Close()
			return nil, errors.New("scan issue goal")
		}
		relations := result[issueID]
		relations.Goal = &goal
		result[issueID] = relations
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate issue goals")
	}
	rows, err = querier.Query(
		ctx,
		`SELECT issue_id, automation_id, automation_run_id, automation_step_run_id
		   FROM automation_issue_origins
		  WHERE issue_id = ANY($1::uuid[])`,
		issueIDs,
	)
	if err != nil {
		return nil, errors.New("load issue origins")
	}
	for rows.Next() {
		var (
			issueID uuid.UUID
			origin  IssueOrigin
		)
		if err := rows.Scan(&issueID, &origin.WorkflowID, &origin.WorkflowRunID, &origin.WorkflowStepRunID); err != nil {
			rows.Close()
			return nil, errors.New("scan issue origin")
		}
		relations := result[issueID]
		relations.Origin = &origin
		result[issueID] = relations
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate issue origins")
	}
	rows, err = querier.Query(
		ctx,
		`SELECT edge.issue_id, edge.depends_on_issue_id,
		        other.id, berry_issue_identifier(board.workspace_id, other.number), other.title, other.status::text
		   FROM issue_dependencies AS edge
		   JOIN issues AS other
		     ON other.id = CASE WHEN edge.issue_id = ANY($1::uuid[]) THEN edge.depends_on_issue_id ELSE edge.issue_id END
		    AND other.deleted_at IS NULL
		   JOIN boards AS board ON board.id = other.board_id
		  WHERE edge.issue_id = ANY($1::uuid[]) OR edge.depends_on_issue_id = ANY($1::uuid[])
		  ORDER BY edge.created_at ASC, other.id ASC`,
		issueIDs,
	)
	if err != nil {
		return nil, errors.New("load issue dependencies")
	}
	defer rows.Close()
	for rows.Next() {
		var (
			dependent, blocker uuid.UUID
			ref                IssueDependencyRef
			status             string
		)
		if err := rows.Scan(&dependent, &blocker, &ref.ID, &ref.Identifier, &ref.Title, &status); err != nil {
			return nil, errors.New("scan issue dependency")
		}
		ref.Status = dbStatusToAPI(status)
		if relations, ok := result[dependent]; ok && ref.ID == blocker {
			relations.DependsOn = append(relations.DependsOn, ref)
			result[dependent] = relations
		}
		if relations, ok := result[blocker]; ok && ref.ID == dependent {
			relations.Blocks = append(relations.Blocks, ref)
			result[blocker] = relations
		}
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate issue dependencies")
	}
	return result, nil
}

// LookupUsers resolves display references for user ids. Unknown ids are
// absent from the result so a caller can fall back to a bare key.
func LookupUsers(ctx context.Context, querier relationQuerier, userIDs []uuid.UUID) (map[uuid.UUID]ActorRef, error) {
	result := make(map[uuid.UUID]ActorRef, len(userIDs))
	if len(userIDs) == 0 {
		return result, nil
	}
	rows, err := querier.Query(
		ctx,
		`SELECT id, name, avatar_url FROM users WHERE id = ANY($1::uuid[])`,
		userIDs,
	)
	if err != nil {
		return nil, errors.New("lookup users")
	}
	defer rows.Close()
	for rows.Next() {
		var ref ActorRef
		if err := rows.Scan(&ref.ID, &ref.Name, &ref.AvatarURL); err != nil {
			return nil, errors.New("scan user")
		}
		ref.Type = "user"
		result[ref.ID] = ref
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate users")
	}
	return result, nil
}
