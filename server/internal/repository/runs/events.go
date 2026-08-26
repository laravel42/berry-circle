package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

type runResource struct {
	ID          uuid.UUID        `json:"id"`
	IssueID     uuid.UUID        `json:"issueId"`
	AgentID     uuid.UUID        `json:"agentId"`
	Status      Status           `json:"status"`
	Sequence    int64            `json:"sequence"`
	Summary     *string          `json:"summary"`
	Usage       usageResource    `json:"usage"`
	Failure     *failureResource `json:"failure"`
	CreatedAt   string           `json:"createdAt"`
	StartedAt   *string          `json:"startedAt"`
	CompletedAt *string          `json:"completedAt"`
}

type usageResource struct {
	InputTokens  int64   `json:"inputTokens"`
	OutputTokens int64   `json:"outputTokens"`
	TotalTokens  int64   `json:"totalTokens"`
	CostMicros   *int64  `json:"costMicros"`
	Currency     *string `json:"currency"`
}

type failureResource struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// eventEnvelope is the run-lane wire shape persisted in outbox_events.payload.
// workspaceId sits next to boardId so a consumer never has to know which lane
// wrote the row to find its scope.
type eventEnvelope struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	OccurredAt  string          `json:"occurredAt"`
	WorkspaceID uuid.UUID       `json:"workspaceId"`
	BoardID     uuid.UUID       `json:"boardId"`
	IssueID     uuid.UUID       `json:"issueId"`
	RunID       *uuid.UUID      `json:"runId"`
	Sequence    *int64          `json:"sequence"`
	Payload     json.RawMessage `json:"payload"`
}

func lifecyclePayload(run Run) (json.RawMessage, error) {
	return marshalPayload(struct {
		Run runResource `json:"run"`
	}{Run: serializeRun(run)})
}

func usagePayload(usage Usage) (json.RawMessage, error) {
	return marshalPayload(struct {
		Usage usageResource `json:"usage"`
	}{Usage: serializeUsage(usage)})
}

func marshalPayload(value any) (json.RawMessage, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("encode run event payload")
	}
	return encoded, nil
}

func serializeRun(run Run) runResource {
	var startedAt *string
	if run.StartedAt != nil {
		value := run.StartedAt.UTC().Format(time.RFC3339Nano)
		startedAt = &value
	}
	var completedAt *string
	if run.CompletedAt != nil {
		value := run.CompletedAt.UTC().Format(time.RFC3339Nano)
		completedAt = &value
	}
	var failure *failureResource
	if run.Failure != nil {
		failure = &failureResource{
			Code:      run.Failure.Code,
			Message:   run.Failure.Message,
			Retryable: run.Failure.Retryable,
		}
	}
	return runResource{
		ID:          run.ID,
		IssueID:     run.IssueID,
		AgentID:     run.AgentID,
		Status:      run.Status,
		Sequence:    run.Sequence,
		Summary:     run.Summary,
		Usage:       serializeUsage(run.Usage),
		Failure:     failure,
		CreatedAt:   run.CreatedAt.UTC().Format(time.RFC3339Nano),
		StartedAt:   startedAt,
		CompletedAt: completedAt,
	}
}

func serializeUsage(usage Usage) usageResource {
	return usageResource{
		InputTokens:  usage.InputTokens,
		OutputTokens: usage.OutputTokens,
		TotalTokens:  usage.TotalTokens,
		CostMicros:   usage.CostMicros,
		Currency:     usage.Currency,
	}
}

func insertPublicEvent(ctx context.Context, tx pgx.Tx, event Event) error {
	if event.RunID == nil || event.Sequence == nil {
		return errors.New("run event requires run and sequence")
	}
	if err := ledger.Append(ctx, tx, ledger.Runs, ledger.Row{
		ID:         event.ID,
		OwnerID:    *event.RunID,
		Scope:      []uuid.UUID{event.BoardID, event.IssueID},
		Sequence:   *event.Sequence,
		Type:       event.Type,
		Payload:    event.Payload,
		Public:     true,
		OccurredAt: event.OccurredAt,
	}); err != nil {
		return err
	}
	return insertOutboxEvent(ctx, tx, event, "run", *event.RunID)
}

// insertOutboxEvent writes the durable row with the workspace in workspace_id
// and the board in board_id. Every caller loads the run through runProjection,
// which carries the workspace; the lookup below covers an event assembled
// without it so a row can never be written with the board in the wrong column
// again.
func insertOutboxEvent(
	ctx context.Context,
	tx pgx.Tx,
	event Event,
	aggregateType string,
	aggregateID uuid.UUID,
) error {
	if event.WorkspaceID == uuid.Nil {
		if err := tx.QueryRow(
			ctx,
			`SELECT workspace_id FROM boards WHERE id = $1`,
			event.BoardID,
		).Scan(&event.WorkspaceID); err != nil {
			return fmt.Errorf("resolve outbox event workspace: %w", err)
		}
	}
	encoded, err := json.Marshal(eventEnvelope{
		ID:          event.ID.String(),
		Type:        event.Type,
		OccurredAt:  event.OccurredAt.UTC().Format(time.RFC3339Nano),
		WorkspaceID: event.WorkspaceID,
		BoardID:     event.BoardID,
		IssueID:     event.IssueID,
		RunID:       event.RunID,
		Sequence:    event.Sequence,
		Payload:     event.Payload,
	})
	if err != nil {
		return errors.New("encode outbox event")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO outbox_events (
			id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
			payload, occurred_at, available_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
		event.ID,
		event.Type,
		aggregateType,
		aggregateID,
		event.WorkspaceID,
		event.BoardID,
		string(encoded),
		event.OccurredAt,
	); err != nil {
		return fmt.Errorf("persist outbox event: %w", err)
	}
	return nil
}

func allocateSequence(ctx context.Context, tx pgx.Tx, runID uuid.UUID) (int64, error) {
	return ledger.Sequence(ctx, tx, ledger.Runs, runID)
}

type actorResource struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

type issueResource struct {
	ID          uuid.UUID      `json:"id"`
	BoardID     uuid.UUID      `json:"boardId"`
	Number      int32          `json:"number"`
	Identifier  string         `json:"identifier"`
	Title       string         `json:"title"`
	Description *string        `json:"description"`
	Status      string         `json:"status"`
	Priority    string         `json:"priority"`
	SortOrder   int32          `json:"sortOrder"`
	DueDate     *string        `json:"dueDate"`
	Assignee    *actorResource `json:"assignee"`
	ActiveRunID *uuid.UUID     `json:"activeRunId"`
	CreatedBy   *actorResource `json:"createdBy"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
}

func issueUpdatedEvent(
	ctx context.Context,
	tx pgx.Tx,
	eventID, runID, issueID uuid.UUID,
	occurredAt time.Time,
) (Event, error) {
	var (
		resource             issueResource
		workspaceID          uuid.UUID
		status, priority     string
		dueDate              *time.Time
		assigneeType         *string
		assigneeID           *uuid.UUID
		assigneeName         *string
		assigneeAvatar       *string
		creatorID            *uuid.UUID
		creatorName          *string
		creatorAvatar        *string
		createdAt, updatedAt time.Time
	)
	err := tx.QueryRow(
		ctx,
		`SELECT i.id, i.board_id, i.number, i.title, i.description,
		        i.status::text, i.priority::text, i.sort_order, i.due_date,
		        i.assignee_type::text, i.assignee_id,
		        COALESCE(assignee_user.name, assignee_agent.name),
		        COALESCE(assignee_user.avatar_url, assignee_agent.avatar_url),
		        i.active_run_id,
		        i.created_by, creator.name, creator.avatar_url,
		        i.created_at, i.updated_at,
		        berry_issue_identifier(b.workspace_id, i.number),
		        b.workspace_id
		   -- Deliberately not filtered on i.deleted_at: this builds the
		   -- payload for an event a run already emitted. A run whose issue was
		   -- deleted still has a history, and refusing to describe it would
		   -- drop events rather than hide them.
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		   LEFT JOIN users AS assignee_user
		     ON i.assignee_type = 'user' AND assignee_user.id = i.assignee_id
		   LEFT JOIN agents AS assignee_agent
		     ON i.assignee_type = 'agent' AND assignee_agent.id = i.assignee_id
		   LEFT JOIN users AS creator ON creator.id = i.created_by
		  WHERE i.id = $1`,
		issueID,
	).Scan(
		&resource.ID,
		&resource.BoardID,
		&resource.Number,
		&resource.Title,
		&resource.Description,
		&status,
		&priority,
		&resource.SortOrder,
		&dueDate,
		&assigneeType,
		&assigneeID,
		&assigneeName,
		&assigneeAvatar,
		&resource.ActiveRunID,
		&creatorID,
		&creatorName,
		&creatorAvatar,
		&createdAt,
		&updatedAt,
		&resource.Identifier,
		&workspaceID,
	)
	if err != nil {
		return Event{}, fmt.Errorf("read issue event snapshot: %w", err)
	}
	resource.Status = issueStatusToAPI(status)
	resource.Priority = priority
	if dueDate != nil {
		value := dueDate.UTC().Format(time.RFC3339Nano)
		resource.DueDate = &value
	}
	if assigneeType != nil && assigneeID != nil {
		name := "Agent"
		if *assigneeType == "user" {
			name = "Unknown user"
		}
		if assigneeName != nil {
			name = *assigneeName
		}
		resource.Assignee = &actorResource{
			Type:      *assigneeType,
			ID:        *assigneeID,
			Name:      name,
			AvatarURL: assigneeAvatar,
		}
	}
	if creatorID != nil {
		name := "Unknown user"
		if creatorName != nil {
			name = *creatorName
		}
		resource.CreatedBy = &actorResource{
			Type:      "user",
			ID:        *creatorID,
			Name:      name,
			AvatarURL: creatorAvatar,
		}
	}
	resource.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	resource.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	payload, err := marshalPayload(struct {
		Issue         issueResource `json:"issue"`
		ChangedFields []string      `json:"changedFields"`
	}{
		Issue:         resource,
		ChangedFields: []string{"activeRunId", "status"},
	})
	if err != nil {
		return Event{}, err
	}
	causeRunID := runID
	return Event{
		ID:          eventID,
		Type:        "issue.updated",
		OccurredAt:  occurredAt,
		WorkspaceID: workspaceID,
		BoardID:     resource.BoardID,
		IssueID:     issueID,
		RunID:       &causeRunID,
		Sequence:    nil,
		Payload:     payload,
	}, nil
}

func issueStatusToAPI(value string) string {
	switch value {
	case "in_progress":
		return "inProgress"
	case "in_review":
		return "inReview"
	default:
		return value
	}
}
