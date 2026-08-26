package automation

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// HookProvider is the integration_webhook_deliveries provider under which
// workflow hook deliveries are recorded.
const HookProvider = "berry_hook"

// MaxHookDeliveryIDLength bounds the caller-supplied delivery id so the
// scoped key stays inside integration_webhook_deliveries_delivery_ck.
const MaxHookDeliveryIDLength = 120

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
