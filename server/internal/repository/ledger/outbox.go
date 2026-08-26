package ledger

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Event is one persisted public event and opaque replay cursor, as read back
// from either ledger table or from outbox_events.
//
// WorkspaceID is the real workspace and BoardID the board the aggregate lives
// on; before migration 019 the run lane stored the board id in the outbox
// workspace column, which is why both are explicit. RunID and Sequence are nil
// for events that no run produced (issue, comment, goal, approval and
// automation facts), and IssueID is uuid.Nil for aggregates without an issue.
type Event struct {
	ID          uuid.UUID
	Type        string
	OccurredAt  time.Time
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	IssueID     uuid.UUID
	RunID       *uuid.UUID
	Sequence    *int64
	Payload     json.RawMessage
}

// OutboxCursor is the stable (occurred_at, id) outbox replay key resolved from
// an opaque event ID. The same pair orders the board and workspace replays.
type OutboxCursor struct {
	OccurredAt time.Time
	ID         uuid.UUID
}

// OutboxScope names the column an outbox replay filters on. The two values
// are the only ones ever interpolated into SQL.
type OutboxScope string

const (
	// OutboxScopeBoard replays one board through outbox_events_board_replay_idx.
	OutboxScopeBoard OutboxScope = "board_id"
	// OutboxScopeWorkspace replays one workspace, including facts that belong
	// to no board, through outbox_events_workspace_replay_idx.
	OutboxScopeWorkspace OutboxScope = "workspace_id"
)

func (scope OutboxScope) valid() bool {
	return scope == OutboxScopeBoard || scope == OutboxScopeWorkspace
}

// OutboxEvent is one durable fact to write in the collaboration envelope
// shape: {id, type, occurredAt, workspaceId, boardId, aggregateType,
// aggregateId, payload}. Goals, approvals and automations write this shape;
// the run lane keeps its own envelope in repository/runs.
type OutboxEvent struct {
	ID            uuid.UUID
	Topic         string
	AggregateType string
	AggregateID   uuid.UUID
	WorkspaceID   uuid.UUID
	// BoardID is nil for a fact that belongs to no board, which keeps it out
	// of the board replay's partial index.
	BoardID    *uuid.UUID
	Payload    json.RawMessage
	OccurredAt time.Time
}

type outboxEnvelope struct {
	ID            uuid.UUID       `json:"id"`
	Type          string          `json:"type"`
	OccurredAt    string          `json:"occurredAt"`
	WorkspaceID   uuid.UUID       `json:"workspaceId"`
	BoardID       *uuid.UUID      `json:"boardId"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   uuid.UUID       `json:"aggregateId"`
	Payload       json.RawMessage `json:"payload"`
}

// WriteOutbox persists one event inside the caller's transaction. It returns
// the Event the caller publishes live after commit.
func WriteOutbox(ctx context.Context, tx Querier, event OutboxEvent) (Event, error) {
	if event.ID == uuid.Nil || event.WorkspaceID == uuid.Nil || event.AggregateID == uuid.Nil ||
		event.Topic == "" || event.AggregateType == "" {
		return Event{}, errors.New("outbox event requires identifiers, a topic and an aggregate type")
	}
	if event.Payload == nil {
		event.Payload = json.RawMessage(`{}`)
	}
	if !json.Valid(event.Payload) {
		return Event{}, errors.New("outbox event payload is invalid")
	}
	if event.BoardID != nil && *event.BoardID == uuid.Nil {
		event.BoardID = nil
	}
	occurredAt := event.OccurredAt.UTC()
	envelope, err := json.Marshal(outboxEnvelope{
		ID:            event.ID,
		Type:          event.Topic,
		OccurredAt:    occurredAt.Format(time.RFC3339Nano),
		WorkspaceID:   event.WorkspaceID,
		BoardID:       event.BoardID,
		AggregateType: event.AggregateType,
		AggregateID:   event.AggregateID,
		Payload:       event.Payload,
	})
	if err != nil {
		return Event{}, errors.New("encode outbox envelope")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO outbox_events (
		    id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
		    payload, occurred_at, available_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)`,
		event.ID,
		event.Topic,
		event.AggregateType,
		event.AggregateID,
		event.WorkspaceID,
		event.BoardID,
		string(envelope),
		occurredAt,
	); err != nil {
		return Event{}, fmt.Errorf("persist outbox event: %w", err)
	}
	result := Event{
		ID:          event.ID,
		Type:        event.Topic,
		OccurredAt:  occurredAt,
		WorkspaceID: event.WorkspaceID,
		Payload:     event.Payload,
	}
	if event.BoardID != nil {
		result.BoardID = *event.BoardID
	}
	result.IssueID = issueIDFromPayload(event.Payload)
	return result, nil
}

// ResolveOutboxCursor validates an opaque outbox event cursor in one scope.
// The caller names the topics its stream carries, so a cursor from a
// different stream over the same scope is refused rather than resumed.
func ResolveOutboxCursor(
	ctx context.Context,
	querier Querier,
	scope OutboxScope,
	scopeID uuid.UUID,
	topics []string,
	eventID uuid.UUID,
	cutoff time.Time,
) (OutboxCursor, error) {
	if !scope.valid() || scopeID == uuid.Nil {
		return OutboxCursor{}, errors.New("outbox replay scope is invalid")
	}
	if len(topics) == 0 {
		return OutboxCursor{}, errors.New("outbox replay requires topics")
	}
	var cursor OutboxCursor
	err := querier.QueryRow(
		ctx,
		`SELECT occurred_at, id
		   FROM outbox_events
		  WHERE id = $1 AND `+string(scope)+` = $2 AND occurred_at >= $3
		    AND topic = ANY($4::text[])`,
		eventID,
		scopeID,
		cutoff,
		topics,
	).Scan(&cursor.OccurredAt, &cursor.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return OutboxCursor{}, ErrCursorExpired
	}
	if err != nil {
		return OutboxCursor{}, errors.New("resolve outbox event cursor")
	}
	return cursor, nil
}

// ReplayOutbox returns persisted outbox envelopes in one scope for the given
// topics, oldest first, after an optional cursor and inside the retention
// window. It never reads Valkey state.
func ReplayOutbox(
	ctx context.Context,
	querier Querier,
	scope OutboxScope,
	scopeID uuid.UUID,
	topics []string,
	after *OutboxCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	if !scope.valid() || scopeID == uuid.Nil {
		return nil, errors.New("outbox replay scope is invalid")
	}
	if limit < 1 {
		return nil, errors.New("outbox event replay limit is invalid")
	}
	if len(topics) == 0 {
		return nil, errors.New("outbox replay requires topics")
	}
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime = after.OccurredAt
		afterID = after.ID
	}
	rows, err := querier.Query(
		ctx,
		`SELECT occurred_at, id, workspace_id, board_id, payload
		   FROM outbox_events
		  WHERE `+string(scope)+` = $1
		    AND occurred_at >= $2
		    AND topic = ANY($3::text[])
		    AND (NOT $4::boolean OR
		        (occurred_at, id) > ($5::timestamptz, $6::uuid))
		  ORDER BY occurred_at ASC, id ASC
		  LIMIT $7`,
		scopeID,
		cutoff,
		topics,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list outbox events")
	}
	defer rows.Close()
	result := make([]Event, 0, limit)
	for rows.Next() {
		var (
			occurredAt  time.Time
			eventID     uuid.UUID
			workspaceID *uuid.UUID
			boardID     *uuid.UUID
			encoded     []byte
		)
		if err := rows.Scan(&occurredAt, &eventID, &workspaceID, &boardID, &encoded); err != nil {
			return nil, errors.New("scan outbox event")
		}
		event, err := DecodeEnvelope(encoded)
		if err != nil {
			return nil, err
		}
		if event.ID != eventID {
			return nil, errors.New("outbox event envelope ID mismatch")
		}
		// The columns are the scope of record: rows written before migration
		// 019 carry no boardId in their envelope, and comment envelopes never
		// carried one, but the backfill filled the column for both.
		if workspaceID != nil {
			event.WorkspaceID = *workspaceID
		}
		if boardID != nil {
			event.BoardID = *boardID
		}
		event.OccurredAt = occurredAt.UTC()
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate outbox events")
	}
	return result, nil
}

// storedEnvelope is the union of every envelope shape found in
// outbox_events.payload: the run lane (boardId/issueId/runId/sequence), the
// collaboration lane (workspaceId/aggregateType/aggregateId) and the issue
// lane, which writes both. Absent fields decode to nil.
type storedEnvelope struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	OccurredAt  string          `json:"occurredAt"`
	WorkspaceID *uuid.UUID      `json:"workspaceId"`
	BoardID     *uuid.UUID      `json:"boardId"`
	IssueID     *uuid.UUID      `json:"issueId"`
	RunID       *uuid.UUID      `json:"runId"`
	Sequence    *int64          `json:"sequence"`
	Payload     json.RawMessage `json:"payload"`
}

// DecodeEnvelope reads one stored outbox envelope of any lane into an Event.
func DecodeEnvelope(encoded []byte) (Event, error) {
	var envelope storedEnvelope
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		return Event{}, errors.New("decode outbox event envelope")
	}
	id, err := uuid.Parse(envelope.ID)
	if err != nil || id == uuid.Nil {
		return Event{}, errors.New("decode outbox event ID")
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, envelope.OccurredAt)
	if err != nil || !json.Valid(envelope.Payload) {
		return Event{}, errors.New("decode outbox event timestamp")
	}
	event := Event{
		ID:         id,
		Type:       envelope.Type,
		OccurredAt: occurredAt.UTC(),
		RunID:      envelope.RunID,
		Sequence:   envelope.Sequence,
		Payload:    append(json.RawMessage(nil), envelope.Payload...),
	}
	if envelope.WorkspaceID != nil {
		event.WorkspaceID = *envelope.WorkspaceID
	}
	if envelope.BoardID != nil {
		event.BoardID = *envelope.BoardID
	}
	if envelope.IssueID != nil {
		event.IssueID = *envelope.IssueID
	} else {
		event.IssueID = issueIDFromPayload(envelope.Payload)
	}
	return event, nil
}

// issueIDFromPayload recovers the issue for collaboration-lane envelopes,
// which name it inside the payload rather than beside it: comment events
// under comment.issueId, attachments, subscriptions and approvals under
// issueId.
func issueIDFromPayload(payload json.RawMessage) uuid.UUID {
	var body struct {
		IssueID *uuid.UUID `json:"issueId"`
		Comment *struct {
			IssueID *uuid.UUID `json:"issueId"`
		} `json:"comment"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return uuid.Nil
	}
	if body.IssueID != nil {
		return *body.IssueID
	}
	if body.Comment != nil && body.Comment.IssueID != nil {
		return *body.Comment.IssueID
	}
	return uuid.Nil
}
