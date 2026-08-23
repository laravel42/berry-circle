package runs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

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
		`SELECT id, event_type, occurred_at, board_id, issue_id,
		        run_id, sequence, payload
		   FROM run_events
		  WHERE run_id = $1
		    AND public
		    AND sequence > $2
		    AND occurred_at >= $3
		  ORDER BY sequence ASC
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
	var cursor BoardCursor
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT occurred_at, id
		   FROM outbox_events
		  WHERE id = $1 AND workspace_id = $2 AND occurred_at >= $3
		    AND topic IN (
		        'run.created', 'run.started', 'run.output.delta',
		        'run.tool.started', 'run.tool.completed',
		        'run.usage.updated', 'run.completed', 'run.failed',
		        'run.cancelled', 'issue.updated', 'comment.created'
		    )`,
		eventID,
		boardID,
		cutoff,
	).Scan(&cursor.OccurredAt, &cursor.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return BoardCursor{}, ErrCursorExpired
	}
	if err != nil {
		return BoardCursor{}, errors.New("resolve board event cursor")
	}
	return cursor, nil
}

// ListBoardEvents replays persisted outbox envelopes, never Valkey state.
func (repository *Repository) ListBoardEvents(
	ctx context.Context,
	boardID uuid.UUID,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	if limit < 1 {
		return nil, errors.New("board event replay limit is invalid")
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
		`SELECT occurred_at, id, payload
		   FROM outbox_events
		  WHERE workspace_id = $1
		    AND occurred_at >= $2
		    AND topic IN (
		        'run.created', 'run.started', 'run.output.delta',
		        'run.tool.started', 'run.tool.completed',
		        'run.usage.updated', 'run.completed', 'run.failed',
		        'run.cancelled', 'issue.updated', 'comment.created'
		    )
		    AND (NOT $3::boolean OR
		        (occurred_at, id) > ($4::timestamptz, $5::uuid))
		  ORDER BY occurred_at ASC, id ASC
		  LIMIT $6`,
		boardID,
		cutoff,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list board events")
	}
	defer rows.Close()
	result := make([]Event, 0, limit)
	for rows.Next() {
		var (
			occurredAt time.Time
			eventID    uuid.UUID
			encoded    []byte
		)
		if err := rows.Scan(&occurredAt, &eventID, &encoded); err != nil {
			return nil, errors.New("scan board event")
		}
		event, err := decodeEnvelope(encoded)
		if err != nil {
			return nil, err
		}
		if event.ID != eventID {
			return nil, errors.New("board event envelope ID mismatch")
		}
		event.OccurredAt = occurredAt.UTC()
		result = append(result, event)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate board events")
	}
	return result, nil
}

func decodeEnvelope(encoded []byte) (Event, error) {
	var envelope eventEnvelope
	if err := json.Unmarshal(encoded, &envelope); err != nil {
		return Event{}, errors.New("decode board event envelope")
	}
	id, err := uuid.Parse(envelope.ID)
	if err != nil || id == uuid.Nil {
		return Event{}, errors.New("decode board event ID")
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, envelope.OccurredAt)
	if err != nil || !json.Valid(envelope.Payload) {
		return Event{}, errors.New("decode board event timestamp")
	}
	return Event{
		ID:         id,
		Type:       envelope.Type,
		OccurredAt: occurredAt.UTC(),
		BoardID:    envelope.BoardID,
		IssueID:    envelope.IssueID,
		RunID:      envelope.RunID,
		Sequence:   envelope.Sequence,
		Payload:    append(json.RawMessage(nil), envelope.Payload...),
	}, nil
}
