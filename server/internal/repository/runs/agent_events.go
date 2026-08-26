package runs

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// AgentEventParams is one agent.* fact about an issue run: the agent started
// working, finished (the stream ended after the runtime's terminal phase), or
// failed (including a body that ended without it).
type AgentEventParams struct {
	RunID      uuid.UUID
	EventID    uuid.UUID
	Topic      string
	Failure    *Failure
	OccurredAt time.Time
}

type agentEventPayload struct {
	AgentID uuid.UUID `json:"agentId"`
	RunID   uuid.UUID `json:"runId"`
	IssueID uuid.UUID `json:"issueId"`
	Status  Status    `json:"status"`
	Failure *Failure  `json:"failure,omitempty"`
}

// RecordAgentEvent writes one agent.* outbox row scoped to the run's
// workspace and board, exactly as every run fact is. It is not a run ledger
// event: it describes the agent, so the aggregate is the agent and a run
// stream cursor never sees it.
func (repository *Repository) RecordAgentEvent(ctx context.Context, params AgentEventParams) (Event, error) {
	switch {
	case params.RunID == uuid.Nil, params.EventID == uuid.Nil, params.OccurredAt.IsZero():
		return Event{}, errors.New("agent event parameters are invalid")
	case params.Topic != "agent.started" && params.Topic != "agent.completed" && params.Topic != "agent.failed":
		return Event{}, errors.New("agent event topic is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin agent event")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := repository.Get(ctx, params.RunID)
	if err != nil {
		return Event{}, err
	}
	payload, err := json.Marshal(agentEventPayload{
		AgentID: run.AgentID, RunID: run.ID, IssueID: run.IssueID, Status: run.Status, Failure: params.Failure,
	})
	if err != nil {
		return Event{}, errors.New("encode agent event payload")
	}
	runID := run.ID
	event := Event{
		ID:          params.EventID,
		Type:        params.Topic,
		OccurredAt:  params.OccurredAt.UTC(),
		WorkspaceID: run.WorkspaceID,
		BoardID:     run.BoardID,
		IssueID:     run.IssueID,
		RunID:       &runID,
		Payload:     payload,
	}
	if err := insertOutboxEvent(ctx, tx, event, "agent", run.AgentID); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, errors.New("commit agent event")
	}
	return event, nil
}
