package runs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// boardStreamTopics is what GET /api/v1/events?boardId= replays: run
// lifecycle, every issue mutation on the board, and new comments.
var boardStreamTopics = []string{
	"run.created", "run.started", "run.output.delta",
	"run.tool.started", "run.tool.completed",
	"run.usage.updated", "run.completed", "run.failed", "run.cancelled",
	"issue.created", "issue.updated", "issue.assigned",
	"issue.started", "issue.completed", "issue.deleted",
	"comment.created",
}

// ResolveRunCursor validates that a public cursor belongs to this run and is
// inside the configured retention window.
func (repository *Repository) ResolveRunCursor(
	ctx context.Context,
	runID, eventID uuid.UUID,
	cutoff time.Time,
) (int64, error) {
	if _, err := repository.Get(ctx, runID); err != nil {
		return 0, err
	}
	var sequence int64
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT sequence
		   FROM run_events
		  WHERE id = $1 AND run_id = $2 AND public AND occurred_at >= $3`,
		eventID,
		runID,
		cutoff,
	).Scan(&sequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrCursorExpired
	}
	if err != nil {
		return 0, errors.New("resolve run event cursor")
	}
	return sequence, nil
}

// ListRunEvents replays authoritative PostgreSQL events after one sequence.
func (repository *Repository) ListRunEvents(
	ctx context.Context,
	runID uuid.UUID,
	afterSequence int64,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	if limit < 1 {
		return nil, errors.New("run event replay limit is invalid")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT e.id, e.event_type, e.occurred_at, e.board_id, e.issue_id,
		        e.run_id, e.sequence, e.payload, b.workspace_id
		   FROM run_events AS e
		   JOIN boards AS b ON b.id = e.board_id
		  WHERE e.run_id = $1
		    AND e.public
		    AND e.sequence > $2
		    AND e.occurred_at >= $3
		  ORDER BY e.sequence ASC
		  LIMIT $4`,
		runID,
		afterSequence,
		cutoff,
		limit,
	)
	if err != nil {
		return nil, errors.New("list run events")
	}
	defer rows.Close()
	result := make([]Event, 0, limit)
	for rows.Next() {
		var (
			event    Event
			run      uuid.UUID
			sequence int64
			payload  []byte
		)
		if err := rows.Scan(
			&event.ID,
			&event.Type,
			&event.OccurredAt,
			&event.BoardID,
			&event.IssueID,
			&run,
			&sequence,
			&payload,
			&event.WorkspaceID,
		); err != nil {
			return nil, errors.New("scan run event")
		}
		event.RunID = &run
		event.Sequence = &sequence
		event.Payload = append(json.RawMessage(nil), payload...)
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate run events")
	}
	return result, nil
}

// ResolveBoardCursor validates an opaque outbox event cursor in board scope.
func (repository *Repository) ResolveBoardCursor(
	ctx context.Context,
	boardID, eventID uuid.UUID,
	cutoff time.Time,
) (BoardCursor, error) {
	return repository.resolveOutboxCursor(
		ctx, "board_id", boardID, boardStreamTopics, eventID, cutoff,
	)
}

// ListBoardEvents replays persisted outbox envelopes, never Valkey state.
func (repository *Repository) ListBoardEvents(
	ctx context.Context,
	boardID uuid.UUID,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	return repository.listOutboxEvents(
		ctx, "board_id", boardID, boardStreamTopics, after, cutoff, limit,
	)
}

// ResolveWorkspaceCursor validates an opaque outbox event cursor in workspace
// scope. The caller names the topics its stream carries, so a cursor from a
// different stream over the same workspace is refused rather than resumed.
func (repository *Repository) ResolveWorkspaceCursor(
	ctx context.Context,
	workspaceID uuid.UUID,
	topics []string,
	eventID uuid.UUID,
	cutoff time.Time,
) (BoardCursor, error) {
	return repository.resolveOutboxCursor(
		ctx, "workspace_id", workspaceID, topics, eventID, cutoff,
	)
}

// ListWorkspaceEvents replays every workspace-scoped outbox envelope for the
// given topics, including facts that belong to no board. It reads through
// outbox_events_workspace_replay_idx.
func (repository *Repository) ListWorkspaceEvents(
	ctx context.Context,
	workspaceID uuid.UUID,
	topics []string,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	return repository.listOutboxEvents(
		ctx, "workspace_id", workspaceID, topics, after, cutoff, limit,
	)
}

// resolveOutboxCursor and listOutboxEvents share one query over the two
// scope columns. scopeColumn is one of two literals chosen here, never caller
// input, which is why it is interpolated.
func (repository *Repository) resolveOutboxCursor(
	ctx context.Context,
	scopeColumn string,
	scopeID uuid.UUID,
	topics []string,
	eventID uuid.UUID,
	cutoff time.Time,
) (BoardCursor, error) {
	if len(topics) == 0 {
		return BoardCursor{}, errors.New("outbox replay requires topics")
	}
	var cursor BoardCursor
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT occurred_at, id
		   FROM outbox_events
		  WHERE id = $1 AND `+scopeColumn+` = $2 AND occurred_at >= $3
		    AND topic = ANY($4::text[])`,
		eventID,
		scopeID,
		cutoff,
		topics,
	).Scan(&cursor.OccurredAt, &cursor.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return BoardCursor{}, ErrCursorExpired
	}
	if err != nil {
		return BoardCursor{}, errors.New("resolve outbox event cursor")
	}
	return cursor, nil
}

func (repository *Repository) listOutboxEvents(
	ctx context.Context,
	scopeColumn string,
	scopeID uuid.UUID,
	topics []string,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
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
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT occurred_at, id, workspace_id, board_id, payload
		   FROM outbox_events
		  WHERE `+scopeColumn+` = $1
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
		event, err := decodeEnvelope(encoded)
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

func decodeEnvelope(encoded []byte) (Event, error) {
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
// under comment.issueId, attachments and subscriptions under issueId.
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
