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

// ListWaitingOn returns the runs parked on one wait key ("approval:<id>",
// "run:<id>", "issue:<id>", "event:<topic>"), oldest first. The trigger
// dispatcher resumes each of them when the matching fact arrives.
func (repository *Repository) ListWaitingOn(ctx context.Context, waitingOn string) ([]Run, error) {
	if waitingOn == "" {
		return nil, errors.New("wait key is required")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runProjection+`
		   FROM automation_runs AS run
		  WHERE run.status = 'waiting' AND run.waiting_on = $1
		  ORDER BY run.created_at ASC, run.id ASC`,
		waitingOn,
	)
	if err != nil {
		return nil, errors.New("list waiting automation runs")
	}
	defer rows.Close()
	result := []Run{}
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, errors.New("scan waiting automation run")
		}
		result = append(result, run)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate waiting automation runs")
	}
	return result, nil
}

// CountOpenRunsForGoal counts the goal's runs that have not finished, which
// is what keeps a goal from completing while a workflow of its own still
// waits on something.
func (repository *Repository) CountOpenRunsForGoal(ctx context.Context, goalID uuid.UUID) (int, error) {
	if goalID == uuid.Nil {
		return 0, errors.New("goal is required")
	}
	var count int
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT count(*) FROM automation_runs
		  WHERE goal_id = $1 AND status IN ('pending', 'running', 'waiting')`,
		goalID,
	).Scan(&count); err != nil {
		return 0, errors.New("count open automation runs")
	}
	return count, nil
}

// IssueOriginParams records which workflow step created an issue.
type IssueOriginParams struct {
	WorkspaceID  uuid.UUID
	IssueID      uuid.UUID
	AutomationID uuid.UUID
	RunID        uuid.UUID
	StepRunID    *uuid.UUID
	CreatedAt    time.Time
}

// RecordIssueOrigin writes the provenance junction for an issue a workflow
// created. Recording it twice for the same issue is the same request.
func (repository *Repository) RecordIssueOrigin(ctx context.Context, params IssueOriginParams) error {
	if params.WorkspaceID == uuid.Nil || params.IssueID == uuid.Nil || params.AutomationID == uuid.Nil || params.RunID == uuid.Nil {
		return errors.New("issue origin parameters are invalid")
	}
	createdAt := params.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now()
	}
	if _, err := repository.Pool.Exec(
		ctx,
		`INSERT INTO automation_issue_origins (
		    workspace_id, issue_id, automation_id, automation_run_id, automation_step_run_id, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (issue_id) DO NOTHING`,
		params.WorkspaceID, params.IssueID, params.AutomationID, params.RunID, params.StepRunID, createdAt.UTC(),
	); err != nil {
		return classifyWrite("record issue origin", err)
	}
	return nil
}

// IssueOrigin is the provenance of a workflow-created issue.
type IssueOrigin struct {
	IssueID      uuid.UUID
	AutomationID uuid.UUID
	RunID        uuid.UUID
	StepRunID    *uuid.UUID
}

// GetIssueOrigin reads the provenance of one issue; ErrNotFound when no
// workflow created it.
func (repository *Repository) GetIssueOrigin(ctx context.Context, issueID uuid.UUID) (IssueOrigin, error) {
	var origin IssueOrigin
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT issue_id, automation_id, automation_run_id, automation_step_run_id
		   FROM automation_issue_origins WHERE issue_id = $1`,
		issueID,
	).Scan(&origin.IssueID, &origin.AutomationID, &origin.RunID, &origin.StepRunID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return IssueOrigin{}, ErrNotFound
		}
		return IssueOrigin{}, errors.New("read issue origin")
	}
	return origin, nil
}

// AgentEventParams is one agent.* fact an inline agent step emits.
type AgentEventParams struct {
	WorkspaceID uuid.UUID
	AgentID     uuid.UUID
	RunID       uuid.UUID
	StepID      string
	Topic       string
	Failure     *Failure
	OccurredAt  time.Time
	NewID       func() uuid.UUID
}

type agentEventPayload struct {
	AgentID         uuid.UUID `json:"agentId"`
	AutomationRunID uuid.UUID `json:"automationRunId"`
	StepID          string    `json:"stepId"`
	Failure         *Failure  `json:"failure,omitempty"`
}

// RecordAgentEvent writes agent.started|completed|failed for an inline agent
// step. Inline steps bypass the issue run ledger, so this is the only trace
// of the model call on the workspace stream.
func (repository *Repository) RecordAgentEvent(ctx context.Context, params AgentEventParams) (Event, error) {
	switch {
	case params.WorkspaceID == uuid.Nil, params.AgentID == uuid.Nil, params.RunID == uuid.Nil, params.OccurredAt.IsZero():
		return Event{}, errors.New("agent event parameters are invalid")
	case params.Topic != "agent.started" && params.Topic != "agent.completed" && params.Topic != "agent.failed":
		return Event{}, errors.New("agent event topic is invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	payload, err := json.Marshal(agentEventPayload{
		AgentID: params.AgentID, AutomationRunID: params.RunID, StepID: params.StepID, Failure: params.Failure,
	})
	if err != nil {
		return Event{}, errors.New("encode agent event payload")
	}
	return ledger.WriteOutbox(ctx, repository.Pool, ledger.OutboxEvent{
		ID: newID(), Topic: params.Topic, AggregateType: "agent", AggregateID: params.AgentID,
		WorkspaceID: params.WorkspaceID, Payload: payload, OccurredAt: params.OccurredAt,
	})
}
