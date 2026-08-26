package p2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var inboxProjectionTopics = []string{
	"issue.updated",
	"comment.created",
	"run.created",
	"run.started",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"approval.requested",
	"approval.approved",
	"approval.rejected",
	"approval.expired",
	"goal.completed",
	"workflow.run.failed",
	"plan.generated",
	"plan.blocked",
	"plan.compile_failed",
}

type projectionEvent struct {
	ID            uuid.UUID
	Topic         string
	AggregateType string
	AggregateID   uuid.UUID
	Payload       json.RawMessage
	OccurredAt    time.Time
}

// projectionTarget is what one event is about and who should hear of it.
// Issue is set for issue-scoped events; the other ids for the aggregate the
// item links to. Recipients are resolved by the aggregate: the issue's
// creator and assignee, an approval's addressee (or every member of the
// addressed role), a goal's or plan's creator, a workflow's creator.
type projectionTarget struct {
	WorkspaceID   uuid.UUID
	Issue         *projectionIssue
	ApprovalID    *uuid.UUID
	GoalID        *uuid.UUID
	WorkflowRunID *uuid.UUID
	PlanID        *uuid.UUID
	Title         string
	Recipients    []uuid.UUID
}

type projectionIssue struct {
	ID             uuid.UUID
	WorkspaceID    uuid.UUID
	Identifier     string
	Title          string
	CreatorID      *uuid.UUID
	UserAssigneeID *uuid.UUID
}

func (repository *Repository) ProjectInboxBatch(
	ctx context.Context,
	newID func() uuid.UUID,
	now func() time.Time,
	limit int,
) (ProjectionResult, error) {
	if newID == nil || now == nil || limit < 1 || limit > 500 {
		return ProjectionResult{}, errors.New("invalid inbox projection options")
	}
	var result ProjectionResult
	for result.Events < limit {
		found, items, err := repository.projectNextInboxEvent(ctx, newID, now().UTC())
		if err != nil {
			return result, err
		}
		if !found {
			return result, nil
		}
		result.Events++
		result.Items += items
	}
	return result, nil
}

func (repository *Repository) projectNextInboxEvent(
	ctx context.Context,
	newID func() uuid.UUID,
	now time.Time,
) (bool, int, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, 0, errors.New("begin inbox projection")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var (
		event   projectionEvent
		payload []byte
	)
	err = tx.QueryRow(
		ctx,
		`SELECT event.id, event.topic, event.aggregate_type, event.aggregate_id,
		        event.payload, event.occurred_at
		   FROM outbox_events AS event
		  WHERE event.topic = ANY($1::text[])
		    AND event.available_at <= $2
		    AND NOT EXISTS (
		        SELECT 1 FROM inbox_projection_events AS projected
		         WHERE projected.event_id = event.id
		    )
		  ORDER BY event.occurred_at ASC, event.id ASC
		  FOR UPDATE OF event SKIP LOCKED
		  LIMIT 1`,
		inboxProjectionTopics,
		now,
	).Scan(
		&event.ID,
		&event.Topic,
		&event.AggregateType,
		&event.AggregateID,
		&payload,
		&event.OccurredAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, errors.New("claim inbox projection event")
	}
	event.Payload = append(json.RawMessage(nil), payload...)
	target, err := resolveProjectionTarget(ctx, tx, event)
	if errors.Is(err, ErrNotFound) {
		if err := writeProjectionReceipt(ctx, tx, event.ID, nil, "skipped", 0, now); err != nil {
			return false, 0, err
		}
		if err := tx.Commit(ctx); err != nil {
			return false, 0, errors.New("commit skipped inbox projection")
		}
		return true, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	category := eventCategory(event)
	actorType, actorID := eventActor(event.Payload)
	created := 0
	var issueID *uuid.UUID
	if target.Issue != nil {
		issueID = &target.Issue.ID
	}
	for _, recipientID := range target.Recipients {
		if actorType != nil && actorID != nil &&
			*actorType == "user" && *actorID == recipientID {
			continue
		}
		enabled, err := notificationEnabled(
			ctx,
			tx,
			target.WorkspaceID,
			recipientID,
			category,
		)
		if err != nil {
			return false, 0, err
		}
		if !enabled {
			continue
		}
		details := boundedProjectionDetails(event)
		tag, err := tx.Exec(
			ctx,
			`INSERT INTO inbox_items (
				id, workspace_id, recipient_id, source_event_id,
				event_type, category, severity, issue_id, actor_type, actor_id,
				title, details, created_at,
				approval_id, goal_id, automation_run_id, plan_id
			 ) VALUES (
				$1, $2, $3, $4, $5, $6, 'info', $7, $8, $9, $10, $11::jsonb, $12,
				$13, $14, $15, $16
			 )
			 ON CONFLICT (recipient_id, source_event_id)
			 WHERE source_event_id IS NOT NULL DO NOTHING`,
			newID(),
			target.WorkspaceID,
			recipientID,
			event.ID,
			event.Topic,
			category,
			issueID,
			actorType,
			actorID,
			target.Title,
			string(details),
			event.OccurredAt.UTC(),
			target.ApprovalID,
			target.GoalID,
			target.WorkflowRunID,
			target.PlanID,
		)
		if err != nil {
			return false, 0, fmt.Errorf("insert projected inbox item: %w", err)
		}
		created += int(tag.RowsAffected())
	}
	outcome := "projected"
	if created == 0 {
		outcome = "suppressed"
	}
	if err := writeProjectionReceipt(
		ctx,
		tx,
		event.ID,
		&target.WorkspaceID,
		outcome,
		created,
		now,
	); err != nil {
		return false, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, 0, errors.New("commit inbox projection")
	}
	return true, created, nil
}

// resolveProjectionTarget routes the event by its aggregate. Issue-lane
// events keep the issue's creator and assignee as recipients; the aggregates
// that arrived with planning resolve their own.
func resolveProjectionTarget(
	ctx context.Context,
	tx pgx.Tx,
	event projectionEvent,
) (projectionTarget, error) {
	switch event.AggregateType {
	case "approval":
		return resolveApprovalTarget(ctx, tx, event)
	case "goal":
		return resolveGoalTarget(ctx, tx, event)
	case "automation_run":
		return resolveRunTarget(ctx, tx, event)
	case "plan":
		return resolvePlanTarget(ctx, tx, event)
	}
	issue, err := resolveProjectionIssue(ctx, tx, event)
	if err != nil {
		return projectionTarget{}, err
	}
	return projectionTarget{
		WorkspaceID: issue.WorkspaceID,
		Issue:       &issue,
		Title:       projectionTitle(event.Topic, issue.Identifier),
		Recipients:  uniqueRecipients(issue.CreatorID, issue.UserAssigneeID),
	}, nil
}

// resolveApprovalTarget addresses the person the approval names, or every
// member whose role satisfies the addressed role. Resolutions go to the
// requester as well, so whoever asked learns the answer.
func resolveApprovalTarget(ctx context.Context, tx pgx.Tx, event projectionEvent) (projectionTarget, error) {
	var (
		approvalID                   = event.AggregateID
		workspaceID                  uuid.UUID
		title, status                string
		issueID, requestedFrom, from *uuid.UUID
		role                         *string
		requestedByType              string
	)
	err := tx.QueryRow(
		ctx,
		`SELECT workspace_id, title, status, issue_id, requested_from_user_id, requested_from_role, requested_by_type, requested_by
		   FROM approvals WHERE id = $1`,
		approvalID,
	).Scan(&workspaceID, &title, &status, &issueID, &requestedFrom, &role, &requestedByType, &from)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectionTarget{}, ErrNotFound
	}
	if err != nil {
		return projectionTarget{}, errors.New("resolve projection approval")
	}
	target := projectionTarget{WorkspaceID: workspaceID, ApprovalID: &approvalID}
	if issueID != nil {
		if issue, err := loadProjectionIssue(ctx, tx, *issueID); err == nil {
			target.Issue = &issue
		}
	}
	var recipients []*uuid.UUID
	switch event.Topic {
	case "approval.requested":
		target.Title = "Approval requested: " + title
		if requestedFrom != nil {
			recipients = append(recipients, requestedFrom)
		} else if role != nil {
			members, err := membersWithRole(ctx, tx, workspaceID, *role)
			if err != nil {
				return projectionTarget{}, err
			}
			for index := range members {
				recipients = append(recipients, &members[index])
			}
		}
	default:
		target.Title = "Approval " + status + ": " + title
		if requestedByType == "user" {
			recipients = append(recipients, from)
		}
		if requestedFrom != nil {
			recipients = append(recipients, requestedFrom)
		}
	}
	target.Recipients = uniqueRecipients(recipients...)
	return target, nil
}

// membersWithRole lists the members who hold the role or a stronger one.
func membersWithRole(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, role string) ([]uuid.UUID, error) {
	roles := map[string][]string{
		"member": {"member", "admin", "owner"},
		"admin":  {"admin", "owner"},
		"owner":  {"owner"},
	}[role]
	if roles == nil {
		return nil, nil
	}
	rows, err := tx.Query(
		ctx,
		`SELECT user_id FROM workspace_memberships
		  WHERE workspace_id = $1 AND role::text = ANY($2::text[])
		  ORDER BY joined_at ASC, user_id ASC
		  LIMIT 200`,
		workspaceID, roles,
	)
	if err != nil {
		return nil, errors.New("resolve approval role members")
	}
	defer rows.Close()
	var members []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, errors.New("scan approval role member")
		}
		members = append(members, id)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate approval role members")
	}
	return members, nil
}

func resolveGoalTarget(ctx context.Context, tx pgx.Tx, event projectionEvent) (projectionTarget, error) {
	var (
		goalID      = event.AggregateID
		workspaceID uuid.UUID
		title       string
		createdBy   *uuid.UUID
	)
	err := tx.QueryRow(ctx, `SELECT workspace_id, title, created_by FROM goals WHERE id = $1`, goalID).Scan(&workspaceID, &title, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectionTarget{}, ErrNotFound
	}
	if err != nil {
		return projectionTarget{}, errors.New("resolve projection goal")
	}
	return projectionTarget{
		WorkspaceID: workspaceID, GoalID: &goalID, Title: "Goal completed: " + title, Recipients: uniqueRecipients(createdBy),
	}, nil
}

func resolveRunTarget(ctx context.Context, tx pgx.Tx, event projectionEvent) (projectionTarget, error) {
	var (
		runID       = event.AggregateID
		workspaceID uuid.UUID
		name        string
		goalID      *uuid.UUID
		createdBy   *uuid.UUID
	)
	err := tx.QueryRow(
		ctx,
		`SELECT run.workspace_id, automation.name, run.goal_id, automation.created_by
		   FROM automation_runs AS run
		   JOIN automations AS automation ON automation.id = run.automation_id
		  WHERE run.id = $1`,
		runID,
	).Scan(&workspaceID, &name, &goalID, &createdBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectionTarget{}, ErrNotFound
	}
	if err != nil {
		return projectionTarget{}, errors.New("resolve projection workflow run")
	}
	return projectionTarget{
		WorkspaceID: workspaceID, WorkflowRunID: &runID, GoalID: goalID, Title: "Workflow failed: " + name, Recipients: uniqueRecipients(createdBy),
	}, nil
}

func resolvePlanTarget(ctx context.Context, tx pgx.Tx, event projectionEvent) (projectionTarget, error) {
	var (
		planID      = event.AggregateID
		workspaceID uuid.UUID
		goalID      *uuid.UUID
		createdBy   *uuid.UUID
		goalTitle   *string
	)
	err := tx.QueryRow(
		ctx,
		`SELECT plan.workspace_id, plan.goal_id, plan.created_by, goal.title
		   FROM plans AS plan
		   LEFT JOIN goals AS goal ON goal.id = plan.goal_id
		  WHERE plan.id = $1`,
		planID,
	).Scan(&workspaceID, &goalID, &createdBy, &goalTitle)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectionTarget{}, ErrNotFound
	}
	if err != nil {
		return projectionTarget{}, errors.New("resolve projection plan")
	}
	subject := "your plan"
	if goalTitle != nil {
		subject = *goalTitle
	}
	title := map[string]string{
		"plan.generated":      "Plan ready: " + subject,
		"plan.blocked":        "Plan needs answers: " + subject,
		"plan.compile_failed": "Plan could not start: " + subject,
	}[event.Topic]
	return projectionTarget{
		WorkspaceID: workspaceID, PlanID: &planID, GoalID: goalID, Title: title, Recipients: uniqueRecipients(createdBy),
	}, nil
}

func loadProjectionIssue(ctx context.Context, tx pgx.Tx, issueID uuid.UUID) (projectionIssue, error) {
	return resolveProjectionIssue(ctx, tx, projectionEvent{AggregateType: "issue", AggregateID: issueID})
}

func resolveProjectionIssue(
	ctx context.Context,
	tx pgx.Tx,
	event projectionEvent,
) (projectionIssue, error) {
	var issueID uuid.UUID
	switch event.AggregateType {
	case "issue":
		issueID = event.AggregateID
	case "run":
		if err := tx.QueryRow(
			ctx,
			"SELECT issue_id FROM runs WHERE id = $1",
			event.AggregateID,
		).Scan(&issueID); errors.Is(err, pgx.ErrNoRows) {
			return projectionIssue{}, ErrNotFound
		} else if err != nil {
			return projectionIssue{}, errors.New("resolve projection run")
		}
	case "comment":
		if err := tx.QueryRow(
			ctx,
			"SELECT issue_id FROM comments WHERE id = $1",
			event.AggregateID,
		).Scan(&issueID); errors.Is(err, pgx.ErrNoRows) {
			return projectionIssue{}, ErrNotFound
		} else if err != nil {
			return projectionIssue{}, errors.New("resolve projection comment")
		}
	default:
		return projectionIssue{}, ErrNotFound
	}
	var issue projectionIssue
	err := tx.QueryRow(
		ctx,
		`SELECT issue.id, board.workspace_id,
		        berry_issue_identifier(board.workspace_id, issue.number),
		        issue.title, issue.created_by,
		        CASE WHEN issue.assignee_type = 'user' THEN issue.assignee_id END
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		    AND issue.deleted_at IS NULL
		  WHERE issue.id = $1`,
		issueID,
	).Scan(
		&issue.ID,
		&issue.WorkspaceID,
		&issue.Identifier,
		&issue.Title,
		&issue.CreatorID,
		&issue.UserAssigneeID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return projectionIssue{}, ErrNotFound
	}
	if err != nil {
		return projectionIssue{}, errors.New("resolve projection issue")
	}
	return issue, nil
}

func notificationEnabled(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, recipientID uuid.UUID,
	category string,
) (bool, error) {
	var enabled bool
	err := tx.QueryRow(
		ctx,
		`SELECT COALESCE(
			(preference.preferences -> 'inApp' ->> $3)::boolean,
			true
		)
		FROM workspace_memberships AS membership
		JOIN workspaces AS workspace
		  ON workspace.id = membership.workspace_id
		 AND workspace.deleted_at IS NULL
		LEFT JOIN notification_preferences AS preference
		  ON preference.workspace_id = membership.workspace_id
		 AND preference.user_id = membership.user_id
		WHERE membership.workspace_id = $1 AND membership.user_id = $2`,
		workspaceID,
		recipientID,
		category,
	).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("resolve notification preference")
	}
	return enabled, nil
}

func writeProjectionReceipt(
	ctx context.Context,
	tx pgx.Tx,
	eventID uuid.UUID,
	workspaceID *uuid.UUID,
	outcome string,
	count int,
	now time.Time,
) error {
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO inbox_projection_events (
			event_id, workspace_id, outcome, inbox_count, projected_at
		 ) VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (event_id) DO NOTHING`,
		eventID,
		workspaceID,
		outcome,
		count,
		now,
	); err != nil {
		return errors.New("record inbox projection receipt")
	}
	return nil
}

func uniqueRecipients(ids ...*uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(ids))
	result := make([]uuid.UUID, 0, len(ids))
	for _, id := range ids {
		if id == nil || *id == uuid.Nil {
			continue
		}
		if _, exists := seen[*id]; exists {
			continue
		}
		seen[*id] = struct{}{}
		result = append(result, *id)
	}
	return result
}

func eventCategory(event projectionEvent) string {
	switch event.Topic {
	case "approval.requested", "approval.approved", "approval.rejected", "approval.expired":
		return "approvals"
	case "goal.completed", "plan.generated", "plan.blocked", "plan.compile_failed":
		return "goals"
	case "workflow.run.failed":
		return "workflows"
	case "comment.created":
		return "comments"
	case "issue.updated":
		var envelope struct {
			Payload struct {
				ChangedFields []string `json:"changedFields"`
			} `json:"payload"`
		}
		if json.Unmarshal(event.Payload, &envelope) == nil {
			for _, field := range envelope.Payload.ChangedFields {
				if field == "assignee" || field == "assigneeId" ||
					field == "assigneeType" {
					return "assignments"
				}
			}
			for _, field := range envelope.Payload.ChangedFields {
				if field == "status" {
					return "statusChanges"
				}
			}
		}
		return "updates"
	default:
		return "agentActivity"
	}
}

func eventActor(payload json.RawMessage) (*string, *uuid.UUID) {
	var envelope struct {
		Payload struct {
			Comment *struct {
				Author *struct {
					Type string    `json:"type"`
					ID   uuid.UUID `json:"id"`
				} `json:"author"`
			} `json:"comment"`
			Actor *struct {
				Type string    `json:"type"`
				ID   uuid.UUID `json:"id"`
			} `json:"actor"`
		} `json:"payload"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return nil, nil
	}
	actor := envelope.Payload.Actor
	if envelope.Payload.Comment != nil && envelope.Payload.Comment.Author != nil {
		actor = envelope.Payload.Comment.Author
	}
	if actor == nil || (actor.Type != "user" && actor.Type != "agent") ||
		actor.ID == uuid.Nil {
		return nil, nil
	}
	actorType, actorID := actor.Type, actor.ID
	return &actorType, &actorID
}

func boundedProjectionDetails(event projectionEvent) json.RawMessage {
	if len(event.Payload) <= 64*1024 && json.Valid(event.Payload) {
		var object map[string]json.RawMessage
		if json.Unmarshal(event.Payload, &object) == nil && object != nil {
			return append(json.RawMessage(nil), event.Payload...)
		}
	}
	encoded, _ := json.Marshal(map[string]string{
		"eventId": event.ID.String(),
		"topic":   event.Topic,
	})
	return encoded
}

func projectionTitle(topic, identifier string) string {
	switch topic {
	case "comment.created":
		return "New comment on " + identifier
	case "issue.updated":
		return identifier + " was updated"
	case "run.failed":
		return "Agent work failed on " + identifier
	case "run.completed":
		return "Agent work completed on " + identifier
	case "run.cancelled":
		return "Agent work was cancelled on " + identifier
	default:
		return "Agent activity on " + identifier
	}
}
