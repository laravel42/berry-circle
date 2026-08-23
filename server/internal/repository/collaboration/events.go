package collaboration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

type outboxEnvelope struct {
	ID            uuid.UUID       `json:"id"`
	Type          string          `json:"type"`
	OccurredAt    string          `json:"occurredAt"`
	WorkspaceID   uuid.UUID       `json:"workspaceId"`
	AggregateType string          `json:"aggregateType"`
	AggregateID   uuid.UUID       `json:"aggregateId"`
	Payload       json.RawMessage `json:"payload"`
}

func makeEvent(
	id, workspaceID uuid.UUID,
	topic, aggregateType string,
	aggregateID uuid.UUID,
	payload any,
	occurredAt time.Time,
) (Event, error) {
	if id == uuid.Nil || workspaceID == uuid.Nil || aggregateID == uuid.Nil {
		return Event{}, errors.New("collaboration event requires non-nil identifiers")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Event{}, errors.New("encode collaboration event payload")
	}
	return Event{
		ID:            id,
		WorkspaceID:   workspaceID,
		Topic:         topic,
		AggregateType: aggregateType,
		AggregateID:   aggregateID,
		Payload:       encoded,
		OccurredAt:    occurredAt.UTC(),
	}, nil
}

func insertOutboxEvent(ctx context.Context, queryer database, event Event) error {
	envelope, err := json.Marshal(outboxEnvelope{
		ID:            event.ID,
		Type:          event.Topic,
		OccurredAt:    event.OccurredAt.UTC().Format(time.RFC3339Nano),
		WorkspaceID:   event.WorkspaceID,
		AggregateType: event.AggregateType,
		AggregateID:   event.AggregateID,
		Payload:       event.Payload,
	})
	if err != nil {
		return errors.New("encode collaboration outbox envelope")
	}
	if _, err := queryer.Exec(
		ctx,
		`INSERT INTO outbox_events (
		    id, topic, aggregate_type, aggregate_id, workspace_id,
		    payload, occurred_at, available_at
		 ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)`,
		event.ID,
		event.Topic,
		event.AggregateType,
		event.AggregateID,
		event.WorkspaceID,
		string(envelope),
		event.OccurredAt,
	); err != nil {
		return fmt.Errorf("persist collaboration outbox event: %w", err)
	}
	return nil
}
