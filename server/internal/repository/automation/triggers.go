package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ClaimParams bounds one dispatcher tick.
type ClaimParams struct {
	Topics []string
	Limit  int
	Now    time.Time
}

// TriggerBatch is one claimed set of outbox events and the transaction that
// holds their row locks. Everything the dispatcher writes for them — runs,
// receipts — goes through it so a crash mid-tick leaves no half-processed
// event: the locks release, the receipts roll back, and the next tick claims
// the events again.
type TriggerBatch struct {
	tx     pgx.Tx
	events []TriggerEvent
}

// Events returns the claimed events in dispatch order.
func (batch *TriggerBatch) Events() []TriggerEvent {
	return batch.events
}

// MatchActive lists the active workflows in a workspace whose Berry event
// trigger names the topic, exactly or through the "<aggregate>.*" wildcard.
func (batch *TriggerBatch) MatchActive(ctx context.Context, workspaceID uuid.UUID, topic string) ([]Automation, error) {
	return matchActive(ctx, batch.tx, workspaceID, topic)
}

// CreateRun records a run for a claimed event inside the batch transaction.
func (batch *TriggerBatch) CreateRun(ctx context.Context, params CreateRunParams) (Run, bool, error) {
	return createRunIn(ctx, batch.tx, params)
}

// WriteReceipt records what happened to one claimed event. The dispatcher
// writes one per event; an event without a receipt is claimed again on the
// next tick, which is the retry.
func (batch *TriggerBatch) WriteReceipt(
	ctx context.Context,
	eventID uuid.UUID,
	workspaceID *uuid.UUID,
	outcome ReceiptOutcome,
	matched int,
	now time.Time,
) error {
	if _, err := batch.tx.Exec(
		ctx,
		`INSERT INTO automation_trigger_receipts (event_id, workspace_id, outcome, matched_count, processed_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (event_id) DO NOTHING`,
		eventID, workspaceID, string(outcome), matched, now.UTC(),
	); err != nil {
		return classifyWrite("record trigger receipt", err)
	}
	return nil
}

// ClaimTriggerBatch locks up to Limit unreceipted events for the topics,
// oldest first, skipping rows another replica holds, hands them to handle,
// and commits when it returns nil. It returns how many events were claimed.
func (repository *Repository) ClaimTriggerBatch(
	ctx context.Context,
	params ClaimParams,
	handle func(context.Context, *TriggerBatch) error,
) (int, error) {
	if len(params.Topics) == 0 || params.Limit < 1 || params.Limit > 500 || handle == nil {
		return 0, errors.New("trigger claim parameters are invalid")
	}
	now := params.Now
	if now.IsZero() {
		now = time.Now()
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, errors.New("begin trigger claim")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`SELECT event.id, event.topic, event.aggregate_type, event.aggregate_id,
		        event.workspace_id, event.board_id, event.payload, event.occurred_at
		   FROM outbox_events AS event
		  WHERE event.topic = ANY($1::text[])
		    AND event.available_at <= $2
		    AND NOT EXISTS (
		        SELECT 1 FROM automation_trigger_receipts AS receipt
		         WHERE receipt.event_id = event.id
		    )
		  ORDER BY event.available_at ASC, event.occurred_at ASC, event.id ASC
		  LIMIT $3
		  FOR UPDATE OF event SKIP LOCKED`,
		params.Topics, now.UTC(), params.Limit,
	)
	if err != nil {
		return 0, errors.New("claim trigger events")
	}
	var events []TriggerEvent
	for rows.Next() {
		var (
			event   TriggerEvent
			payload []byte
		)
		if err := rows.Scan(
			&event.ID, &event.Topic, &event.AggregateType, &event.AggregateID,
			&event.WorkspaceID, &event.BoardID, &payload, &event.OccurredAt,
		); err != nil {
			rows.Close()
			return 0, errors.New("scan trigger event")
		}
		event.Payload = append(json.RawMessage(nil), payload...)
		event.OccurredAt = event.OccurredAt.UTC()
		events = append(events, event)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, errors.New("iterate trigger events")
	}
	if len(events) == 0 {
		return 0, nil
	}
	if err := handle(ctx, &TriggerBatch{tx: tx, events: events}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, errors.New("commit trigger claim")
	}
	return len(events), nil
}

// MatchActive is the batch matcher outside a claim, for callers that only
// need to know what would fire.
func (repository *Repository) MatchActive(ctx context.Context, workspaceID uuid.UUID, topic string) ([]Automation, error) {
	return matchActive(ctx, repository.Pool, workspaceID, topic)
}

func matchActive(ctx context.Context, queryer database, workspaceID uuid.UUID, topic string) ([]Automation, error) {
	if workspaceID == uuid.Nil || topic == "" {
		return nil, errors.New("trigger match parameters are invalid")
	}
	rows, err := queryer.Query(
		ctx,
		`SELECT `+automationProjection+`
		   FROM automations AS automation
		  WHERE automation.workspace_id = $1
		    AND automation.status = 'active'
		    AND automation.trigger_type = 'berry_event'
		    AND (automation.trigger_event = $2
		         OR automation.trigger_event = split_part($2, '.', 1) || '.*')
		  ORDER BY automation.created_at ASC, automation.id ASC`,
		workspaceID, topic,
	)
	if err != nil {
		return nil, errors.New("match active automations")
	}
	defer rows.Close()
	result := []Automation{}
	for rows.Next() {
		item, err := scanAutomation(rows)
		if err != nil {
			return nil, errors.New("scan matched automation")
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate matched automations")
	}
	return result, nil
}
