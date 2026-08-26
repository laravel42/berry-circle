package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// IssueEventKind is the mutation an issue event describes.
type IssueEventKind string

const (
	IssueEventCreated IssueEventKind = "created"
	IssueEventUpdated IssueEventKind = "updated"
	IssueEventDeleted IssueEventKind = "deleted"
)

// IssueEventParams describes one committed issue mutation for the outbox.
//
// ChangedFields carries wire names (title, status, assignee, ...) and
// PreviousStatus the storage status the issue left, both only meaningful for
// updates. Actor is the user or agent that made the change; the inbox projector
// uses it to avoid notifying someone of their own edit.
type IssueEventParams struct {
	IssueID        uuid.UUID
	Kind           IssueEventKind
	ChangedFields  []string
	PreviousStatus string
	Actor          *ActorKey
	OccurredAt     time.Time
	// NewID mints event ids. Nil falls back to uuid.New so writers that do
	// not thread an id source (the p2 batch lane) still record events.
	NewID func() uuid.UUID
}

// RecordIssueEvents writes the issue.* outbox rows for one mutation inside the
// caller's transaction and returns them for post-commit publication.
//
// An update always yields issue.updated. It additionally yields issue.assigned
// when the assignee changed to someone, issue.started when the status moved to
// in_progress and issue.completed when it moved to done, because automations
// subscribe to those moments by name rather than by diffing changedFields.
// Derived events are stamped a microsecond apart so (occurred_at, id) replay
// keeps them in emission order.
func RecordIssueEvents(
	ctx context.Context,
	tx pgx.Tx,
	params IssueEventParams,
) ([]IssueMutationEvent, error) {
	if params.IssueID == uuid.Nil {
		return nil, errors.New("issue event requires an issue")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	snapshot, err := loadIssueSnapshot(ctx, tx, params.IssueID)
	if err != nil {
		return nil, err
	}
	var topics []string
	switch params.Kind {
	case IssueEventCreated:
		topics = []string{"issue.created"}
	case IssueEventDeleted:
		topics = []string{"issue.deleted"}
	case IssueEventUpdated:
		topics = []string{"issue.updated"}
		if containsField(params.ChangedFields, "assignee") && snapshot.Assignee != nil {
			topics = append(topics, "issue.assigned")
		}
		if params.PreviousStatus != "" && params.PreviousStatus != snapshot.Status {
			switch snapshot.Status {
			case "in_progress":
				topics = append(topics, "issue.started")
			case "done":
				topics = append(topics, "issue.completed")
			}
		}
	default:
		return nil, fmt.Errorf("unsupported issue event kind %q", params.Kind)
	}
	payload, err := json.Marshal(issueEventPayload{
		Issue:          serializeIssueEvent(snapshot),
		ChangedFields:  nonNilFields(params.ChangedFields),
		PreviousStatus: nullableStatus(params.PreviousStatus),
		Actor:          params.Actor,
	})
	if err != nil {
		return nil, errors.New("encode issue event payload")
	}
	events := make([]IssueMutationEvent, 0, len(topics))
	occurredAt := params.OccurredAt.UTC()
	for index, topic := range topics {
		event := IssueMutationEvent{
			ID:          newID(),
			Type:        topic,
			WorkspaceID: snapshot.WorkspaceID,
			BoardID:     snapshot.BoardID,
			IssueID:     snapshot.ID,
			Payload:     payload,
			OccurredAt:  occurredAt.Add(time.Duration(index) * time.Microsecond),
		}
		if err := insertIssueOutboxEvent(ctx, tx, event); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, nil
}

// issueEventEnvelope is the union of the run-lane and collaboration-lane
// envelope shapes, so both the board replay and the inbox projector read it
// without a special case. runId and sequence are always null: no run caused
// the mutation.
type issueEventEnvelope struct {
	ID            uuid.UUID       `json:"id"`
	Type          string          `json:"type"`
	OccurredAt    string          `json:"occurredAt"`
	WorkspaceID   uuid.UUID       `json:"workspaceId"`
	BoardID       uuid.UUID       `json:"boardId"`
	IssueID       uuid.UUID       `json:"issueId"`
	RunID         *uuid.UUID      `json:"runId"`
	Sequence      *int64          `json:"sequence"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   uuid.UUID       `json:"aggregateId"`
	Payload       json.RawMessage `json:"payload"`
}

func insertIssueOutboxEvent(
	ctx context.Context,
	tx pgx.Tx,
	event IssueMutationEvent,
) error {
	envelope, err := json.Marshal(issueEventEnvelope{
		ID:            event.ID,
		Type:          event.Type,
		OccurredAt:    event.OccurredAt.UTC().Format(time.RFC3339Nano),
		WorkspaceID:   event.WorkspaceID,
		BoardID:       event.BoardID,
		IssueID:       event.IssueID,
		AggregateType: "issue",
		AggregateID:   event.IssueID,
		Payload:       event.Payload,
	})
	if err != nil {
		return errors.New("encode issue outbox envelope")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO outbox_events (
		    id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
		    payload, occurred_at, available_at
		 ) VALUES ($1, $2, 'issue', $3, $4, $5, $6::jsonb, $7, $7)`,
		event.ID,
		event.Type,
		event.IssueID,
		event.WorkspaceID,
		event.BoardID,
		string(envelope),
		event.OccurredAt,
	); err != nil {
		return fmt.Errorf("persist issue outbox event: %w", err)
	}
	return nil
}

// loadIssueSnapshot reads the issue as it is now, deleted or not. The
// issue.deleted event is the one reader that must describe a row the live
// projection would hide.
func loadIssueSnapshot(
	ctx context.Context,
	queryer queryRower,
	id uuid.UUID,
) (Issue, error) {
	issue, err := scanIssue(queryer.QueryRow(
		ctx,
		`SELECT `+issueProjection+issueSourceAny+`
		  WHERE i.id = $1`,
		id,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Issue{}, ErrNotFound
	}
	if err != nil {
		return Issue{}, fmt.Errorf("read issue event snapshot: %w", err)
	}
	return issue, nil
}

type issueEventPayload struct {
	Issue          issueEventResource `json:"issue"`
	ChangedFields  []string           `json:"changedFields"`
	PreviousStatus *string            `json:"previousStatus,omitempty"`
	Actor          *ActorKey          `json:"actor,omitempty"`
}

// issueEventResource mirrors the public Issue shape so a stream consumer can
// apply the snapshot without a second request. Statuses are wire values.
type issueEventResource struct {
	ID          uuid.UUID   `json:"id"`
	BoardID     uuid.UUID   `json:"boardId"`
	Number      int32       `json:"number"`
	Identifier  string      `json:"identifier"`
	Title       string      `json:"title"`
	Description *string     `json:"description"`
	Status      string      `json:"status"`
	Priority    string      `json:"priority"`
	SortOrder   int32       `json:"sortOrder"`
	DueDate     *string     `json:"dueDate"`
	Assignee    *ActorRef   `json:"assignee"`
	ActiveRunID *uuid.UUID  `json:"activeRunId"`
	Project     *ProjectRef `json:"project"`
	CreatedBy   *ActorRef   `json:"createdBy"`
	CreatedAt   string      `json:"createdAt"`
	UpdatedAt   string      `json:"updatedAt"`
}

func serializeIssueEvent(issue Issue) issueEventResource {
	var dueDate *string
	if issue.DueDate != nil {
		value := issue.DueDate.UTC().Format(time.RFC3339Nano)
		dueDate = &value
	}
	return issueEventResource{
		ID:          issue.ID,
		BoardID:     issue.BoardID,
		Number:      issue.Number,
		Identifier:  issue.Identifier(),
		Title:       issue.Title,
		Description: issue.Description,
		Status:      dbStatusToAPI(issue.Status),
		Priority:    issue.Priority,
		SortOrder:   issue.SortOrder,
		DueDate:     dueDate,
		Assignee:    issue.Assignee,
		ActiveRunID: issue.ActiveRunID,
		Project:     issue.Project,
		CreatedBy:   issue.CreatedBy,
		CreatedAt:   issue.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   issue.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func containsField(fields []string, name string) bool {
	for _, field := range fields {
		if field == name {
			return true
		}
	}
	return false
}

func nonNilFields(fields []string) []string {
	if fields == nil {
		return []string{}
	}
	return fields
}

func nullableStatus(status string) *string {
	if status == "" {
		return nil
	}
	value := dbStatusToAPI(status)
	return &value
}
