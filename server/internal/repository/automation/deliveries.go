package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// HookProvider is the integration_webhook_deliveries provider under which
// workflow hook deliveries are recorded.
const HookProvider = "berry_hook"

// MaxHookDeliveryIDLength bounds the caller-supplied delivery id so the
// scoped key stays inside integration_webhook_deliveries_delivery_ck.
const MaxHookDeliveryIDLength = 120

// WebhookReceivedTopic is the outbox topic a provider delivery becomes.
const WebhookReceivedTopic = "integration.webhook.received"

// RecordHookDelivery writes one inbound hook delivery to the ingest ledger
// and reports whether it was new. The id is scoped to the workflow, so two
// workflows may receive the same caller-supplied id. The run itself is
// deduplicated by CreateRun on its source key; this row is the audit and
// retention record the provider ingestors share.
func (repository *Repository) RecordHookDelivery(
	ctx context.Context,
	automationID uuid.UUID,
	workspaceID uuid.UUID,
	deliveryID string,
	now time.Time,
) (bool, error) {
	if automationID == uuid.Nil || deliveryID == "" || len(deliveryID) > MaxHookDeliveryIDLength {
		return false, errors.New("hook delivery parameters are invalid")
	}
	// The workspace is resolved through a subselect so a delivery for a
	// workspace deleted in the meantime records without a null-FK failure.
	tag, err := repository.Pool.Exec(
		ctx,
		`INSERT INTO integration_webhook_deliveries (provider, delivery_id, workspace_id, event_type, received_at)
		 VALUES ($1, $2, (SELECT id FROM workspaces WHERE id = $3), 'workflow.hook', $4)
		 ON CONFLICT (provider, delivery_id) DO NOTHING`,
		HookProvider, HookDeliveryKey(automationID, deliveryID), workspaceID, now.UTC(),
	)
	if err != nil {
		return false, classifyWrite("record hook delivery", err)
	}
	return tag.RowsAffected() == 1, nil
}

// HookDeliveryKey is the ledger key of one delivery to one workflow.
func HookDeliveryKey(automationID uuid.UUID, deliveryID string) string {
	return automationID.String() + ":" + deliveryID
}

// IngestParams is one verified provider delivery.
type IngestParams struct {
	Provider string
	// DeliveryID is the provider's own delivery identifier; the pair
	// (provider, deliveryId) is what deduplicates a redelivery.
	DeliveryID  string
	WorkspaceID uuid.UUID
	// Event is the normalised event name a trigger's operation matches.
	Event string
	// Payload is the delivery body as received, bounded by the caller.
	Payload    json.RawMessage
	ReceivedAt time.Time
	NewID      func() uuid.UUID
}

type webhookReceivedPayload struct {
	Provider   string          `json:"provider"`
	Event      string          `json:"event"`
	DeliveryID string          `json:"deliveryId"`
	Payload    json.RawMessage `json:"payload"`
}

// IngestWebhook records a provider delivery and, when it is new, writes the
// integration.webhook.received fact that lets the dispatcher match
// integration triggers — both in one transaction, so a delivery is either
// fully ingested or free to be redelivered. A redelivery returns false with
// no event.
func (repository *Repository) IngestWebhook(ctx context.Context, params IngestParams) (Event, bool, error) {
	switch {
	case params.Provider == "", params.Provider == HookProvider, params.DeliveryID == "", len(params.DeliveryID) > 200,
		params.WorkspaceID == uuid.Nil, params.Event == "", params.ReceivedAt.IsZero():
		return Event{}, false, errors.New("webhook ingest parameters are invalid")
	}
	payload := params.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`null`)
	}
	if !json.Valid(payload) {
		return Event{}, false, errors.New("webhook payload is invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, false, errors.New("begin webhook ingest")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var deliveryRowID uuid.UUID
	err = tx.QueryRow(
		ctx,
		`INSERT INTO integration_webhook_deliveries (id, provider, delivery_id, workspace_id, event_type, received_at)
		 VALUES ($1, $2, $3, (SELECT id FROM workspaces WHERE id = $4), $5, $6)
		 ON CONFLICT (provider, delivery_id) DO NOTHING
		 RETURNING id`,
		newID(), params.Provider, params.DeliveryID, params.WorkspaceID, boundEventType(params.Event), params.ReceivedAt.UTC(),
	).Scan(&deliveryRowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Event{}, false, nil
	}
	if err != nil {
		return Event{}, false, classifyWrite("record webhook delivery", err)
	}
	encoded, err := json.Marshal(webhookReceivedPayload{
		Provider: params.Provider, Event: params.Event, DeliveryID: params.DeliveryID, Payload: payload,
	})
	if err != nil {
		return Event{}, false, errors.New("encode webhook event payload")
	}
	event, err := ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID: newID(), Topic: WebhookReceivedTopic, AggregateType: "integration_webhook", AggregateID: deliveryRowID,
		WorkspaceID: params.WorkspaceID, Payload: encoded, OccurredAt: params.ReceivedAt,
	})
	if err != nil {
		return Event{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, false, errors.New("commit webhook ingest")
	}
	return event, true, nil
}

func boundEventType(event string) string {
	if len(event) <= 100 {
		return event
	}
	return event[:100]
}
