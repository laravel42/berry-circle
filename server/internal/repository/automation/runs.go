package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

const runProjection = `
	run.id, run.workspace_id, run.automation_id, run.automation_version, run.goal_id, run.status,
	run.trigger_type, run.trigger_payload, run.source_event_key, run.current_step_id, run.waiting_on,
	run.resume_at, run.sequence, run.engine, run.engine_run_id, run.failure_code, run.failure_message,
	run.input_tokens, run.output_tokens, run.cost_micros, run.requested_by, run.request_id,
	run.created_at, run.started_at, run.completed_at, run.updated_at`

func scanRun(row rowScanner) (Run, error) {
	var (
		run                         Run
		status, triggerType, engine string
		payload                     []byte
		failureCode, failureMessage *string
	)
	if err := row.Scan(
		&run.ID, &run.WorkspaceID, &run.AutomationID, &run.AutomationVersion, &run.GoalID, &status,
		&triggerType, &payload, &run.SourceEventKey, &run.CurrentStepID, &run.WaitingOn,
		&run.ResumeAt, &run.Sequence, &engine, &run.EngineRunID, &failureCode, &failureMessage,
		&run.Usage.InputTokens, &run.Usage.OutputTokens, &run.Usage.CostMicros, &run.RequestedBy, &run.RequestID,
		&run.CreatedAt, &run.StartedAt, &run.CompletedAt, &run.UpdatedAt,
	); err != nil {
		return Run{}, err
	}
	run.Status = RunStatus(status)
	run.TriggerType = automation.TriggerType(triggerType)
	run.TriggerPayload = append(json.RawMessage(nil), payload...)
	run.Engine = Engine(engine)
	if failureCode != nil && failureMessage != nil {
		run.Failure = &Failure{Code: *failureCode, Message: *failureMessage}
	}
	return run, nil
}

// GetRun returns one run.
func (repository *Repository) GetRun(ctx context.Context, runID uuid.UUID) (Run, error) {
	return getRun(ctx, repository.Pool, runID, false)
}

func getRun(ctx context.Context, queryer database, runID uuid.UUID, lock bool) (Run, error) {
	if runID == uuid.Nil {
		return Run{}, ErrNotFound
	}
	statement := `SELECT ` + runProjection + ` FROM automation_runs AS run WHERE run.id = $1`
	if lock {
		statement += ` FOR UPDATE`
	}
	run, err := scanRun(queryer.QueryRow(ctx, statement, runID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, errors.New("get automation run")
	}
	return run, nil
}

// GetRunWithSteps returns a run and every step attempt, oldest first.
func (repository *Repository) GetRunWithSteps(ctx context.Context, runID uuid.UUID) (Run, []StepRun, error) {
	run, err := repository.GetRun(ctx, runID)
	if err != nil {
		return Run{}, nil, err
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+stepProjection+` FROM automation_step_runs AS step
		  WHERE step.automation_run_id = $1
		  ORDER BY step.created_at ASC, step.id ASC`,
		runID,
	)
	if err != nil {
		return Run{}, nil, errors.New("list automation step runs")
	}
	defer rows.Close()
	steps := []StepRun{}
	for rows.Next() {
		step, err := scanStep(rows)
		if err != nil {
			return Run{}, nil, errors.New("scan automation step run")
		}
		steps = append(steps, step)
	}
	if err := rows.Err(); err != nil {
		return Run{}, nil, errors.New("iterate automation step runs")
	}
	return run, steps, nil
}

// ListRuns returns one over-fetched stable page, newest first, for a
// workspace or one of its workflows.
func (repository *Repository) ListRuns(
	ctx context.Context,
	filter RunListFilter,
	after *RunCursor,
	limit int,
) ([]Run, error) {
	if filter.WorkspaceID == uuid.Nil || limit < 1 {
		return nil, errors.New("automation run list configuration is invalid")
	}
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.CreatedAt, after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runProjection+`
		   FROM automation_runs AS run
		  WHERE run.workspace_id = $1
		    AND ($2::uuid IS NULL OR run.automation_id = $2::uuid)
		    AND ($3 = '' OR run.status = $3)
		    AND (NOT $4::boolean OR
		        (run.created_at, run.id) < ($5::timestamptz, $6::uuid))
		  ORDER BY run.created_at DESC, run.id DESC
		  LIMIT $7`,
		filter.WorkspaceID, filter.AutomationID, string(filter.Status),
		afterEnabled, afterTime, afterID, limit,
	)
	if err != nil {
		return nil, errors.New("list automation runs")
	}
	defer rows.Close()
	result := make([]Run, 0, limit)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, errors.New("scan automation run")
		}
		result = append(result, run)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate automation runs")
	}
	return result, nil
}

// CreateRun records one pending run. It is idempotent per
// (workflow, source event key): a second request for the same event returns
// the existing run and false. Only an active workflow runs.
func (repository *Repository) CreateRun(ctx context.Context, params CreateRunParams) (Run, bool, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, false, errors.New("begin automation run")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	run, created, err := createRunIn(ctx, tx, params)
	if err != nil {
		return Run{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, false, errors.New("commit automation run")
	}
	return run, created, nil
}

func createRunIn(ctx context.Context, tx database, params CreateRunParams) (Run, bool, error) {
	if params.ID == uuid.Nil || params.AutomationID == uuid.Nil || !params.TriggerType.Valid() || params.CreatedAt.IsZero() {
		return Run{}, false, errors.New("automation run parameters are invalid")
	}
	payload := params.Payload
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	if !json.Valid(payload) {
		return Run{}, false, errors.New("automation run payload is invalid")
	}
	// Two replicas that claim the same event on the same tick serialise here;
	// the partial unique index on the source key is the backstop.
	if _, err := tx.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended('automation:' || $1::text, 0))`,
		params.AutomationID,
	); err != nil {
		return Run{}, false, errors.New("lock automation for run creation")
	}
	item, err := getAutomation(ctx, tx, params.AutomationID, false)
	if err != nil {
		return Run{}, false, err
	}
	if item.Status != StatusActive {
		return Run{}, false, ErrNotActive
	}
	if params.SourceEventKey != nil {
		var existing uuid.UUID
		err := tx.QueryRow(
			ctx,
			`SELECT id FROM automation_runs WHERE automation_id = $1 AND source_event_key = $2`,
			params.AutomationID, *params.SourceEventKey,
		).Scan(&existing)
		if err == nil {
			run, err := getRun(ctx, tx, existing, false)
			return run, false, err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return Run{}, false, errors.New("check automation run idempotency")
		}
	}
	var requestID *string
	if params.RequestID != "" {
		requestID = &params.RequestID
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO automation_runs (
		    id, workspace_id, automation_id, automation_version, goal_id, status, trigger_type,
		    trigger_payload, source_event_key, engine, requested_by, request_id, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7::jsonb, $8, $9, $10, $11, $12, $12)`,
		params.ID, item.WorkspaceID, item.ID, item.Version, item.GoalID, string(params.TriggerType),
		string(payload), params.SourceEventKey, string(item.Engine), params.RequestedBy, requestID, params.CreatedAt.UTC(),
	); err != nil {
		return Run{}, false, classifyWrite("insert automation run", err)
	}
	run, err := getRun(ctx, tx, params.ID, false)
	if err != nil {
		return Run{}, false, err
	}
	return run, true, nil
}

// MarkRunning moves a pending run to running and records workflow.run.started.
func (repository *Repository) MarkRunning(ctx context.Context, runID uuid.UUID, now time.Time, newID func() uuid.UUID) (Run, Event, error) {
	return repository.transitionRun(ctx, runID, now, newID, "workflow.run.started", nil,
		func(run Run) error {
			if run.Status != RunPending {
				return ErrRunState
			}
			return nil
		},
		`UPDATE automation_runs SET status = 'running', started_at = COALESCE(started_at, $2), updated_at = $2 WHERE id = $1`)
}

// MarkWaiting parks a running run on what the current step waits for.
func (repository *Repository) MarkWaiting(
	ctx context.Context,
	runID uuid.UUID,
	stepID, waitingOn string,
	resumeAt *time.Time,
	now time.Time,
	newID func() uuid.UUID,
) (Run, Event, error) {
	if waitingOn == "" {
		return Run{}, Event{}, errors.New("automation run needs something to wait on")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin automation run wait")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	run, err := getRun(ctx, tx, runID, true)
	if err != nil {
		return Run{}, Event{}, err
	}
	if run.Status != RunRunning {
		if run.Status.Terminal() {
			return Run{}, Event{}, ErrRunTerminal
		}
		return Run{}, Event{}, ErrRunState
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_runs
		    SET status = 'waiting', current_step_id = NULLIF($2, ''), waiting_on = $3, resume_at = $4, updated_at = $5
		  WHERE id = $1`,
		runID, stepID, waitingOn, resumeAt, now.UTC(),
	); err != nil {
		return Run{}, Event{}, classifyWrite("park automation run", err)
	}
	return finishRunTransition(ctx, tx, runID, "workflow.run.waiting", runEventPayload{StepID: nullable(stepID), WaitingOn: &waitingOn}, now, newID)
}

// Resume returns a waiting run to running and records workflow.run.resumed.
func (repository *Repository) Resume(ctx context.Context, runID uuid.UUID, now time.Time, newID func() uuid.UUID) (Run, Event, error) {
	return repository.transitionRun(ctx, runID, now, newID, "workflow.run.resumed", nil,
		func(run Run) error {
			if run.Status != RunWaiting {
				if run.Status.Terminal() {
					return ErrRunTerminal
				}
				return ErrRunState
			}
			return nil
		},
		`UPDATE automation_runs SET status = 'running', waiting_on = NULL, resume_at = NULL, updated_at = $2 WHERE id = $1`)
}

// CompleteSuccess finishes a running run.
func (repository *Repository) CompleteSuccess(ctx context.Context, runID uuid.UUID, now time.Time, newID func() uuid.UUID) (Run, Event, error) {
	return repository.transitionRun(ctx, runID, now, newID, "workflow.run.succeeded", nil,
		func(run Run) error {
			if run.Status != RunRunning {
				if run.Status.Terminal() {
					return ErrRunTerminal
				}
				return ErrRunState
			}
			return nil
		},
		`UPDATE automation_runs SET status = 'succeeded', current_step_id = NULL, waiting_on = NULL, resume_at = NULL, completed_at = $2, updated_at = $2 WHERE id = $1`)
}

// Fail finishes a run with a stable code. Nothing is retried automatically.
func (repository *Repository) Fail(ctx context.Context, runID uuid.UUID, failure Failure, now time.Time, newID func() uuid.UUID) (Run, Event, error) {
	if failure.Code == "" || failure.Message == "" {
		return Run{}, Event{}, errors.New("automation run failure needs a code and a message")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin automation run failure")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	run, err := getRun(ctx, tx, runID, true)
	if err != nil {
		return Run{}, Event{}, err
	}
	if run.Status.Terminal() {
		return Run{}, Event{}, ErrRunTerminal
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_runs
		    SET status = 'failed', failure_code = $2, failure_message = $3,
		        waiting_on = NULL, resume_at = NULL, completed_at = $4, updated_at = $4
		  WHERE id = $1`,
		runID, failure.Code, failure.Message, now.UTC(),
	); err != nil {
		return Run{}, Event{}, classifyWrite("fail automation run", err)
	}
	return finishRunTransition(ctx, tx, runID, "workflow.run.failed", runEventPayload{StepID: run.CurrentStepID}, now, newID)
}

// Cancel stops a run that has not finished.
func (repository *Repository) Cancel(ctx context.Context, runID uuid.UUID, actor *uuid.UUID, now time.Time, newID func() uuid.UUID) (Run, Event, error) {
	var key *core.ActorKey
	if actor != nil {
		key = &core.ActorKey{Type: "user", ID: *actor}
	}
	return repository.transitionRun(ctx, runID, now, newID, "workflow.run.cancelled", key,
		func(run Run) error {
			if run.Status.Terminal() {
				return ErrRunTerminal
			}
			return nil
		},
		`UPDATE automation_runs SET status = 'cancelled', waiting_on = NULL, resume_at = NULL, completed_at = $2, updated_at = $2 WHERE id = $1`)
}

// AddUsage sums an inline model call into the run.
func (repository *Repository) AddUsage(ctx context.Context, runID uuid.UUID, usage automation.Usage, now time.Time) error {
	return addUsage(ctx, repository.Pool, runID, usage, now)
}

func addUsage(ctx context.Context, execer database, runID uuid.UUID, usage automation.Usage, now time.Time) error {
	tag, err := execer.Exec(
		ctx,
		`UPDATE automation_runs
		    SET input_tokens = input_tokens + $2,
		        output_tokens = output_tokens + $3,
		        cost_micros = CASE WHEN $4::bigint IS NULL THEN cost_micros ELSE COALESCE(cost_micros, 0) + $4 END,
		        updated_at = $5
		  WHERE id = $1`,
		runID, usage.InputTokens, usage.OutputTokens, usage.CostMicros, now.UTC(),
	)
	if err != nil {
		return classifyWrite("record automation run usage", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (repository *Repository) transitionRun(
	ctx context.Context,
	runID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
	topic string,
	actor *core.ActorKey,
	check func(Run) error,
	statement string,
) (Run, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin automation run transition")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	run, err := getRun(ctx, tx, runID, true)
	if err != nil {
		return Run{}, Event{}, err
	}
	if err := check(run); err != nil {
		return Run{}, Event{}, err
	}
	if _, err := tx.Exec(ctx, statement, runID, now.UTC()); err != nil {
		return Run{}, Event{}, classifyWrite("transition automation run", err)
	}
	return finishRunTransition(ctx, tx, runID, topic, runEventPayload{Actor: actor, StepID: run.CurrentStepID}, now, newID)
}

// finishRunTransition reads the run back, appends the ledger event and
// commits. The caller holds the run's row lock.
func finishRunTransition(
	ctx context.Context,
	tx pgx.Tx,
	runID uuid.UUID,
	topic string,
	payload runEventPayload,
	now time.Time,
	newID func() uuid.UUID,
) (Run, Event, error) {
	run, err := getRun(ctx, tx, runID, false)
	if err != nil {
		return Run{}, Event{}, err
	}
	payload.Run = serializeRun(run)
	event, err := appendRunEvent(ctx, tx, run, topic, payload, now, newID)
	if err != nil {
		return Run{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, Event{}, errors.New("commit automation run transition")
	}
	run.Sequence++
	return run, event, nil
}

// ClaimResumable takes waiting runs whose timer has elapsed back to running,
// at most limit at a time and skipping runs another scheduler holds. Moving
// them to running inside the claim means a second scheduler cannot resume
// the same run twice.
func (repository *Repository) ClaimResumable(ctx context.Context, now time.Time, limit int, newID func() uuid.UUID) ([]Run, []Event, error) {
	if limit < 1 || limit > 500 {
		return nil, nil, errors.New("automation resume limit is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, nil, errors.New("begin automation resume claim")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`SELECT id FROM automation_runs
		  WHERE status = 'waiting' AND resume_at IS NOT NULL AND resume_at <= $1
		  ORDER BY resume_at ASC, id ASC
		  LIMIT $2
		  FOR UPDATE SKIP LOCKED`,
		now.UTC(), limit,
	)
	if err != nil {
		return nil, nil, errors.New("select resumable automation runs")
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, errors.New("scan resumable automation run")
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, errors.New("iterate resumable automation runs")
	}
	runs := make([]Run, 0, len(ids))
	events := make([]Event, 0, len(ids))
	for _, id := range ids {
		if _, err := tx.Exec(
			ctx,
			`UPDATE automation_runs SET status = 'running', waiting_on = NULL, resume_at = NULL, updated_at = $2 WHERE id = $1`,
			id, now.UTC(),
		); err != nil {
			return nil, nil, classifyWrite("resume automation run", err)
		}
		run, err := getRun(ctx, tx, id, false)
		if err != nil {
			return nil, nil, err
		}
		event, err := appendRunEvent(ctx, tx, run, "workflow.run.resumed", runEventPayload{StepID: run.CurrentStepID, Run: serializeRun(run)}, now, newID)
		if err != nil {
			return nil, nil, err
		}
		run.Sequence++
		runs = append(runs, run)
		events = append(events, event)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, errors.New("commit automation resume claim")
	}
	return runs, events, nil
}

// RunCounts is what a workflow page shows beside its definition.
type RunCounts struct {
	Total     int
	Succeeded int
	Failed    int
}

// CountRuns tallies a workflow's runs by outcome.
func (repository *Repository) CountRuns(ctx context.Context, automationID uuid.UUID) (RunCounts, error) {
	var counts RunCounts
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT count(*),
		        count(*) FILTER (WHERE status = 'succeeded'),
		        count(*) FILTER (WHERE status = 'failed')
		   FROM automation_runs WHERE automation_id = $1`,
		automationID,
	).Scan(&counts.Total, &counts.Succeeded, &counts.Failed); err != nil {
		return RunCounts{}, errors.New("count automation runs")
	}
	return counts, nil
}
