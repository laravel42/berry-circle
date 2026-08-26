package automation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ClaimParams bounds one dispatcher tick. WorkspaceID narrows the claim to
// one workspace; nil, the production setting, claims across all of them.
type ClaimParams struct {
	Topics      []string
	Limit       int
	Now         time.Time
	WorkspaceID *uuid.UUID
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

// maxReceiptReasonLength mirrors automation_trigger_receipts_reason_ck.
const maxReceiptReasonLength = 500

// WriteReceipt records what happened to one claimed event. The dispatcher
// writes one per event and the receipt is final: an event with a receipt is
// never offered again, whatever its outcome, because the work an event
// starts (a provider call, an agent run) must not be repeated by a loop. The
// reason says why an event was skipped or failed; it is empty for a match.
func (batch *TriggerBatch) WriteReceipt(
	ctx context.Context,
	eventID uuid.UUID,
	workspaceID *uuid.UUID,
	outcome ReceiptOutcome,
	matched int,
	reason string,
	now time.Time,
) error {
	// The workspace is resolved through a subselect: an event whose workspace
	// was deleted after the fact records a receipt with a null workspace
	// instead of violating the foreign key, which would abort the claim
	// transaction and leave every event in the batch unreceipted forever.
	if _, err := batch.tx.Exec(
		ctx,
		`INSERT INTO automation_trigger_receipts (event_id, workspace_id, outcome, matched_count, reason, processed_at)
		 VALUES ($1, (SELECT id FROM workspaces WHERE id = $2), $3, $4, NULLIF($5, ''), $6)
		 ON CONFLICT (event_id) DO NOTHING`,
		eventID, workspaceID, string(outcome), matched, boundReason(reason), now.UTC(),
	); err != nil {
		return classifyWrite("record trigger receipt", err)
	}
	return nil
}

func boundReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if len(reason) <= maxReceiptReasonLength {
		return reason
	}
	cut := reason[:maxReceiptReasonLength]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// OldestUnreceipted is the available_at of the oldest event the dispatcher
// has not receipted, or nil when it is caught up. It is what the lag gauge
// reports.
func (repository *Repository) OldestUnreceipted(ctx context.Context, topics []string) (*time.Time, error) {
	if len(topics) == 0 {
		return nil, errors.New("trigger lag parameters are invalid")
	}
	var oldest *time.Time
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT min(event.available_at)
		   FROM outbox_events AS event
		  WHERE event.topic = ANY($1::text[])
		    AND NOT EXISTS (
		        SELECT 1 FROM automation_trigger_receipts AS receipt
		         WHERE receipt.event_id = event.id
		    )`,
		topics,
	).Scan(&oldest); err != nil {
		return nil, errors.New("read trigger lag")
	}
	if oldest != nil {
		value := oldest.UTC()
		oldest = &value
	}
	return oldest, nil
}

// Receipt is one recorded dispatcher outcome.
type Receipt struct {
	EventID      uuid.UUID
	WorkspaceID  *uuid.UUID
	Outcome      ReceiptOutcome
	MatchedCount int
	Reason       string
	ProcessedAt  time.Time
}

// GetReceipt reads the receipt of one event.
func (repository *Repository) GetReceipt(ctx context.Context, eventID uuid.UUID) (Receipt, error) {
	var (
		receipt Receipt
		outcome string
		reason  *string
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT event_id, workspace_id, outcome, matched_count, reason, processed_at
		   FROM automation_trigger_receipts WHERE event_id = $1`,
		eventID,
	).Scan(&receipt.EventID, &receipt.WorkspaceID, &outcome, &receipt.MatchedCount, &reason, &receipt.ProcessedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Receipt{}, ErrNotFound
	}
	if err != nil {
		return Receipt{}, errors.New("read trigger receipt")
	}
	receipt.Outcome = ReceiptOutcome(outcome)
	if reason != nil {
		receipt.Reason = *reason
	}
	receipt.ProcessedAt = receipt.ProcessedAt.UTC()
	return receipt, nil
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
		    AND ($4::uuid IS NULL OR event.workspace_id = $4::uuid)
		    AND NOT EXISTS (
		        SELECT 1 FROM automation_trigger_receipts AS receipt
		         WHERE receipt.event_id = event.id
		    )
		  ORDER BY event.available_at ASC, event.occurred_at ASC, event.id ASC
		  LIMIT $3
		  FOR UPDATE OF event SKIP LOCKED`,
		params.Topics, now.UTC(), params.Limit, params.WorkspaceID,
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
