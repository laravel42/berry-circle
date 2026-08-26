package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

const stepProjection = `
	step.id, step.workspace_id, step.automation_run_id, step.step_id, step.step_type, step.attempt, step.status,
	step.input, step.output, step.failure_code, step.failure_message, step.run_id, step.issue_id, step.approval_id,
	step.audit_event_id, step.engine_step_id, step.usage, step.started_at, step.completed_at, step.created_at, step.updated_at`

func scanStep(row rowScanner) (StepRun, error) {
	var (
		step                        StepRun
		stepType, status            string
		input, output, usage        []byte
		failureCode, failureMessage *string
	)
	if err := row.Scan(
		&step.ID, &step.WorkspaceID, &step.RunID, &step.StepID, &stepType, &step.Attempt, &status,
		&input, &output, &failureCode, &failureMessage, &step.IssueRunID, &step.IssueID, &step.ApprovalID,
		&step.AuditEventID, &step.EngineStepID, &usage, &step.StartedAt, &step.CompletedAt, &step.CreatedAt, &step.UpdatedAt,
	); err != nil {
		return StepRun{}, err
	}
	step.StepType = automation.StepType(stepType)
	step.Status = StepStatus(status)
	if input != nil {
		step.Input = append(json.RawMessage(nil), input...)
	}
	if output != nil {
		step.Output = append(json.RawMessage(nil), output...)
	}
	if usage != nil {
		step.Usage = append(json.RawMessage(nil), usage...)
	}
	if failureCode != nil {
		message := ""
		if failureMessage != nil {
			message = *failureMessage
		}
		step.Failure = &Failure{Code: *failureCode, Message: message}
	}
	return step, nil
}

// GetStep returns one step attempt.
func (repository *Repository) GetStep(ctx context.Context, stepRunID uuid.UUID) (StepRun, error) {
	return getStep(ctx, repository.Pool, stepRunID, false)
}

func getStep(ctx context.Context, queryer database, stepRunID uuid.UUID, lock bool) (StepRun, error) {
	if stepRunID == uuid.Nil {
		return StepRun{}, ErrNotFound
	}
	statement := `SELECT ` + stepProjection + ` FROM automation_step_runs AS step WHERE step.id = $1`
	if lock {
		statement += ` FOR UPDATE`
	}
	step, err := scanStep(queryer.QueryRow(ctx, statement, stepRunID))
	if errors.Is(err, pgx.ErrNoRows) {
		return StepRun{}, ErrNotFound
	}
	if err != nil {
		return StepRun{}, errors.New("get automation step run")
	}
	return step, nil
}

// StartStep opens one attempt of a step on a running run, makes it the
// current step and records workflow.step.started.
func (repository *Repository) StartStep(ctx context.Context, params StartStepParams) (StepRun, Event, error) {
	if params.ID == uuid.Nil || params.RunID == uuid.Nil || !automation.ValidStepID(params.StepID) ||
		!automation.KnownStepTypes[params.StepType] || params.Now.IsZero() {
		return StepRun{}, Event{}, errors.New("automation step start parameters are invalid")
	}
	if params.Attempt < 1 {
		params.Attempt = 1
	}
	if len(params.Input) > 0 && !json.Valid(params.Input) {
		return StepRun{}, Event{}, errors.New("automation step input is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return StepRun{}, Event{}, errors.New("begin automation step start")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	run, err := getRun(ctx, tx, params.RunID, true)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	if run.Status != RunRunning {
		if run.Status.Terminal() {
			return StepRun{}, Event{}, ErrRunTerminal
		}
		return StepRun{}, Event{}, ErrRunState
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO automation_step_runs (
		    id, workspace_id, automation_run_id, step_id, step_type, attempt, status, input,
		    started_at, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, 'running', $7::jsonb, $8, $8, $8)`,
		params.ID, run.WorkspaceID, run.ID, params.StepID, string(params.StepType), params.Attempt,
		nullableJSON(params.Input), params.Now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("insert automation step run", err)
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_runs SET current_step_id = $2, updated_at = $3 WHERE id = $1`,
		run.ID, params.StepID, params.Now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("set automation run current step", err)
	}
	return finishStepTransition(ctx, tx, params.ID, "workflow.step.started", nil, params.Now, params.NewID)
}

// CompleteStep records a successful attempt with its output, usage and the
// rows it produced, summing inline model usage into the run.
func (repository *Repository) CompleteStep(
	ctx context.Context,
	stepRunID uuid.UUID,
	output json.RawMessage,
	usage *automation.Usage,
	links StepLinks,
	now time.Time,
	newID func() uuid.UUID,
) (StepRun, Event, error) {
	if len(output) > 0 && !json.Valid(output) {
		return StepRun{}, Event{}, errors.New("automation step output is invalid")
	}
	var encodedUsage *string
	if usage != nil {
		encoded, err := json.Marshal(usage)
		if err != nil {
			return StepRun{}, Event{}, errors.New("encode automation step usage")
		}
		text := string(encoded)
		encodedUsage = &text
	}
	tx, step, err := repository.lockStep(ctx, stepRunID)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if step.Status != StepRunning && step.Status != StepWaiting {
		return StepRun{}, Event{}, ErrStepState
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_step_runs
		    SET status = 'succeeded', output = $2::jsonb, usage = COALESCE($3::jsonb, usage),
		        run_id = COALESCE($4, run_id), issue_id = COALESCE($5, issue_id),
		        approval_id = COALESCE($6, approval_id), audit_event_id = COALESCE($7, audit_event_id),
		        engine_step_id = COALESCE($8, engine_step_id),
		        completed_at = $9, updated_at = $9
		  WHERE id = $1`,
		stepRunID, nullableJSON(output), encodedUsage,
		links.IssueRunID, links.IssueID, links.ApprovalID, links.AuditEventID, links.EngineStepID, now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("complete automation step run", err)
	}
	if usage != nil {
		if err := addUsage(ctx, tx, step.RunID, *usage, now); err != nil {
			return StepRun{}, Event{}, err
		}
	}
	return finishStepTransition(ctx, tx, stepRunID, "workflow.step.succeeded", nil, now, newID)
}

// FailStep records a failed attempt.
func (repository *Repository) FailStep(ctx context.Context, stepRunID uuid.UUID, failure Failure, now time.Time, newID func() uuid.UUID) (StepRun, Event, error) {
	if failure.Code == "" {
		return StepRun{}, Event{}, errors.New("automation step failure needs a code")
	}
	tx, step, err := repository.lockStep(ctx, stepRunID)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if step.Status.Terminal() {
		return StepRun{}, Event{}, ErrStepState
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_step_runs
		    SET status = 'failed', failure_code = $2, failure_message = $3, completed_at = $4, updated_at = $4
		  WHERE id = $1`,
		stepRunID, failure.Code, failure.Message, now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("fail automation step run", err)
	}
	return finishStepTransition(ctx, tx, stepRunID, "workflow.step.failed", nil, now, newID)
}

// SkipStep closes an attempt whose failure policy is skip, or a branch the
// run did not take.
func (repository *Repository) SkipStep(ctx context.Context, stepRunID uuid.UUID, now time.Time, newID func() uuid.UUID) (StepRun, Event, error) {
	tx, step, err := repository.lockStep(ctx, stepRunID)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if step.Status.Terminal() {
		return StepRun{}, Event{}, ErrStepState
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_step_runs SET status = 'skipped', completed_at = $2, updated_at = $2 WHERE id = $1`,
		stepRunID, now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("skip automation step run", err)
	}
	return finishStepTransition(ctx, tx, stepRunID, "workflow.step.skipped", nil, now, newID)
}

// WaitStep parks an attempt on what it waits for and records the rows it
// waits through (an approval, an issue run, an issue).
func (repository *Repository) WaitStep(
	ctx context.Context,
	stepRunID uuid.UUID,
	waitingOn string,
	links StepLinks,
	now time.Time,
	newID func() uuid.UUID,
) (StepRun, Event, error) {
	if waitingOn == "" {
		return StepRun{}, Event{}, errors.New("automation step needs something to wait on")
	}
	tx, step, err := repository.lockStep(ctx, stepRunID)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if step.Status != StepRunning {
		return StepRun{}, Event{}, ErrStepState
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE automation_step_runs
		    SET status = 'waiting',
		        run_id = COALESCE($2, run_id), issue_id = COALESCE($3, issue_id),
		        approval_id = COALESCE($4, approval_id), audit_event_id = COALESCE($5, audit_event_id),
		        engine_step_id = COALESCE($6, engine_step_id),
		        updated_at = $7
		  WHERE id = $1`,
		stepRunID, links.IssueRunID, links.IssueID, links.ApprovalID, links.AuditEventID, links.EngineStepID, now.UTC(),
	); err != nil {
		return StepRun{}, Event{}, classifyWrite("park automation step run", err)
	}
	return finishStepTransition(ctx, tx, stepRunID, "workflow.step.waiting", &waitingOn, now, newID)
}

// lockStep locks the step's run first and then the step, the order every
// step transition uses, so two transitions on one run never deadlock.
func (repository *Repository) lockStep(ctx context.Context, stepRunID uuid.UUID) (pgx.Tx, StepRun, error) {
	if stepRunID == uuid.Nil {
		return nil, StepRun{}, ErrNotFound
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, StepRun{}, errors.New("begin automation step transition")
	}
	var runID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`SELECT automation_run_id FROM automation_step_runs WHERE id = $1`,
		stepRunID,
	).Scan(&runID); err != nil {
		_ = tx.Rollback(context.Background())
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, StepRun{}, ErrNotFound
		}
		return nil, StepRun{}, errors.New("resolve automation step run")
	}
	if _, err := getRun(ctx, tx, runID, true); err != nil {
		_ = tx.Rollback(context.Background())
		return nil, StepRun{}, err
	}
	step, err := getStep(ctx, tx, stepRunID, true)
	if err != nil {
		_ = tx.Rollback(context.Background())
		return nil, StepRun{}, err
	}
	return tx, step, nil
}

func finishStepTransition(
	ctx context.Context,
	tx pgx.Tx,
	stepRunID uuid.UUID,
	topic string,
	waitingOn *string,
	now time.Time,
	newID func() uuid.UUID,
) (StepRun, Event, error) {
	step, err := getStep(ctx, tx, stepRunID, false)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	run, err := getRun(ctx, tx, step.RunID, false)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	stepID := step.StepID
	event, err := appendRunEvent(ctx, tx, run, topic, runEventPayload{
		StepID: &stepID, WaitingOn: waitingOn, Step: serializeStep(step),
	}, now, newID)
	if err != nil {
		return StepRun{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return StepRun{}, Event{}, errors.New("commit automation step transition")
	}
	return step, event, nil
}

func nullableJSON(value json.RawMessage) *string {
	if len(value) == 0 {
		return nil
	}
	text := string(value)
	return &text
}
