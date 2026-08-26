package agents

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

// RecordAsk writes one ask to the ledger. Implements AskStore.
func (store PostgresStore) RecordAsk(ctx context.Context, record AskRecord) error {
	if store.Pool == nil {
		return errors.New("agent store pool is nil")
	}
	if record.ID == uuid.Nil || record.WorkspaceID == uuid.Nil || record.AgentID == uuid.Nil || record.Status == "" {
		return errors.New("ask record is incomplete")
	}
	var requestedBy *uuid.UUID
	if record.RequestedBy != uuid.Nil {
		requestedBy = &record.RequestedBy
	}
	var answer *string
	if len(record.Answer) > 0 {
		text := string(record.Answer)
		answer = &text
	}
	var completedAt any
	if !record.CompletedAt.IsZero() {
		completedAt = record.CompletedAt.UTC()
	}
	if _, err := store.Pool.Exec(
		ctx,
		`INSERT INTO agent_asks (
		    id, workspace_id, agent_id, requested_by, request_id, status, prompt_bytes, answer,
		    failure_code, failure_message, model_provider, model_name,
		    input_tokens, output_tokens, cost_micros, currency, upstream_request_id, created_at, completed_at
		 ) VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8::jsonb, NULLIF($9, ''), NULLIF($10, ''), NULLIF($11, ''), NULLIF($12, ''),
		    $13, $14, $15, NULLIF($16, ''), NULLIF($17, ''), $18, $19)`,
		record.ID, record.WorkspaceID, record.AgentID, requestedBy, record.RequestID, record.Status, record.PromptBytes, answer,
		record.FailureCode, record.Failure, record.ModelProvider, record.ModelName,
		record.InputTokens, record.OutputTokens, record.CostMicros, record.Currency, record.UpstreamID, record.CreatedAt.UTC(), completedAt,
	); err != nil {
		return errors.New("record agent ask")
	}
	return nil
}
