package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ClaimDispatch atomically moves one queued run from pending to dispatching.
// A claimed run is never automatically claimed again, even after a crash.
func (repository *Repository) ClaimDispatch(
	ctx context.Context,
	runID uuid.UUID,
	now time.Time,
) (Dispatch, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Dispatch{}, errors.New("begin dispatch claim")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, runID)
	if err != nil {
		return Dispatch{}, err
	}
	if run.Terminal() {
		return Dispatch{}, ErrRunTerminal
	}
	if run.Status != StatusQueued || run.DispatchState != DispatchPending {
		return Dispatch{}, ErrDispatchAlreadyClaimed
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET dispatch_state = 'dispatching',
		        dispatch_version = dispatch_version + 1,
		        dispatch_attempted_at = $2,
		        updated_at = $2
		  WHERE id = $1`,
		runID,
		now,
	); err != nil {
		return Dispatch{}, errors.New("claim run dispatch")
	}
	var result Dispatch
	var (
		description  *string
		instructions *string
		requestID    *string
		traceparent  *string
		boardSlug    string
		number       int32
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT r.id, r.issue_id, r.board_id, r.agent_id,
		        r.upstream_agent_id::uuid,
		        b.slug, i.number, i.title, i.description,
		        r.instructions, r.request_id, r.traceparent,
		        b.workspace_id,
		        COALESCE(project.github_repo_full_name, '')
		   FROM runs AS r
		   JOIN issues AS i ON i.id = r.issue_id
		   JOIN boards AS b ON b.id = r.board_id
		   -- The repository the work belongs in, reached through the issue's
		   -- project. Left joins throughout: an issue in no project, or a
		   -- project naming no repository, still dispatches — it just carries
		   -- no code context.
		   LEFT JOIN issue_project_links AS link ON link.issue_id = i.id
		   LEFT JOIN projects AS project
		     ON project.id = link.project_id AND project.deleted_at IS NULL
		  WHERE r.id = $1`,
		runID,
	).Scan(
		&result.RunID,
		&result.IssueID,
		&result.BoardID,
		&result.AgentID,
		&result.UpstreamAgentID,
		&boardSlug,
		&number,
		&result.IssueTitle,
		&description,
		&instructions,
		&requestID,
		&traceparent,
		&result.WorkspaceID,
		&result.Repository,
	); err != nil {
		return Dispatch{}, errors.New("load dispatch context")
	}
	result.IssueIdentifier = stringsUpper(boardSlug) + "-" + fmt.Sprint(number)
	result.IssueDescription = description
	result.Instructions = instructions
	if requestID != nil {
		result.RequestID = *requestID
	}
	if traceparent != nil {
		result.TraceParent = *traceparent
	}
	if err := tx.Commit(ctx); err != nil {
		return Dispatch{}, errors.New("commit dispatch claim")
	}
	return result, nil
}

// MarkRunning persists run.started only after upstream returned a valid stream.
func (repository *Repository) MarkRunning(
	ctx context.Context,
	runID, eventID uuid.UUID,
	upstreamRequestID string,
	now time.Time,
) (Run, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin run start")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, runID)
	if err != nil {
		return Run{}, Event{}, err
	}
	if run.Terminal() {
		return Run{}, Event{}, ErrRunTerminal
	}
	if run.Status != StatusQueued ||
		(run.DispatchState != Dispatching &&
			run.DispatchState != DispatchCancelRequested) {
		return Run{}, Event{}, ErrConflict
	}
	nextDispatchState := DispatchStreaming
	if run.DispatchState == DispatchCancelRequested {
		nextDispatchState = DispatchCancelRequested
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET status = 'running',
		        started_at = COALESCE(started_at, $2),
		        dispatch_state = $3,
		        dispatch_accepted_at = $2,
		        upstream_request_id = NULLIF($4, ''),
		        updated_at = $2
		  WHERE id = $1`,
		runID,
		now,
		string(nextDispatchState),
		upstreamRequestID,
	); err != nil {
		return Run{}, Event{}, errors.New("mark run running")
	}
	sequence, err := allocateSequence(ctx, tx, runID)
	if err != nil {
		return Run{}, Event{}, err
	}
	eventAt, err := nextEventTime(ctx, tx, runID, now)
	if err != nil {
		return Run{}, Event{}, err
	}
	started := now.UTC()
	run.Status = StatusRunning
	run.StartedAt = &started
	run.Sequence = sequence
	run.DispatchState = nextDispatchState
	run.UpdatedAt = started
	if upstreamRequestID != "" {
		run.UpstreamRequestID = &upstreamRequestID
	}
	payload, err := marshalPayload(struct {
		StartedAt string `json:"startedAt"`
	}{StartedAt: started.Format(time.RFC3339Nano)})
	if err != nil {
		return Run{}, Event{}, err
	}
	event := runEvent(eventID, "run.started", run, sequence, payload, eventAt)
	if err := insertPublicEvent(ctx, tx, event); err != nil {
		return Run{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, Event{}, errors.New("commit run start")
	}
	return run, event, nil
}

// AppendOutput persists a bounded safe display delta before delivery.
func (repository *Repository) AppendOutput(
	ctx context.Context,
	runID, eventID uuid.UUID,
	channel, text string,
	now time.Time,
) (Event, error) {
	payload, err := marshalPayload(struct {
		Channel string `json:"channel"`
		Text    string `json:"text"`
	}{Channel: channel, Text: text})
	if err != nil {
		return Event{}, err
	}
	return repository.appendActiveEvent(
		ctx,
		runID,
		eventID,
		"run.output.delta",
		payload,
		now,
		func(ctx context.Context, tx pgx.Tx) error {
			_, err := tx.Exec(
				ctx,
				`UPDATE runs
				    SET output = left(output || $2, 1048576),
				        updated_at = $3
				  WHERE id = $1`,
				runID,
				text,
				now,
			)
			return err
		},
	)
}

// AppendToolStarted emits only a redacted tool name and generated call ID.
func (repository *Repository) AppendToolStarted(
	ctx context.Context,
	runID, eventID uuid.UUID,
	toolCallID, name string,
	now time.Time,
) (Event, error) {
	payload, err := marshalPayload(struct {
		ToolCallID   string  `json:"toolCallId"`
		Name         string  `json:"name"`
		InputSummary *string `json:"inputSummary"`
	}{
		ToolCallID: toolCallID,
		Name:       name,
	})
	if err != nil {
		return Event{}, err
	}
	return repository.appendActiveEvent(
		ctx, runID, eventID, "run.tool.started", payload, now, nil,
	)
}

// AppendToolCompleted deliberately omits raw tool input/output.
func (repository *Repository) AppendToolCompleted(
	ctx context.Context,
	runID, eventID uuid.UUID,
	toolCallID string,
	succeeded bool,
	now time.Time,
) (Event, error) {
	status := "failed"
	if succeeded {
		status = "succeeded"
	}
	payload, err := marshalPayload(struct {
		ToolCallID    string  `json:"toolCallId"`
		Status        string  `json:"status"`
		OutputSummary *string `json:"outputSummary"`
	}{
		ToolCallID: toolCallID,
		Status:     status,
	})
	if err != nil {
		return Event{}, err
	}
	return repository.appendActiveEvent(
		ctx, runID, eventID, "run.tool.completed", payload, now, nil,
	)
}

// RecordProviderEvent stores only explicitly redacted, bounded metadata.
func (repository *Repository) RecordProviderEvent(
	ctx context.Context,
	runID, eventID uuid.UUID,
	eventType string,
	metadata map[string]string,
	now time.Time,
) error {
	encoded, err := json.Marshal(metadata)
	if err != nil || len(encoded) > 16*1024 {
		return errors.New("provider event metadata is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin provider event")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var sequence int64
	if err := tx.QueryRow(
		ctx,
		`SELECT berry_allocate_provider_event_sequence($1)`,
		runID,
	).Scan(&sequence); err != nil {
		return errors.New("allocate provider event sequence")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO run_provider_events (
			id, run_id, sequence, event_type, metadata, occurred_at
		 ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
		eventID,
		runID,
		sequence,
		eventType,
		string(encoded),
		now,
	); err != nil {
		return errors.New("persist provider event")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit provider event")
	}
	return nil
}

// CompleteSuccess persists cumulative usage, terminal success, and inReview.
func (repository *Repository) CompleteSuccess(
	ctx context.Context,
	params SuccessParams,
) (Run, []Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, nil, errors.New("begin run success")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, params.RunID)
	if err != nil {
		return Run{}, nil, err
	}
	if run.Terminal() {
		return Run{}, nil, ErrRunTerminal
	}
	// A cancellation that was requested but not yet confirmed outranks a
	// clean stream end. A run stays completable for as long as it streams
	// now that done is a turn boundary, and the stop call itself ends the
	// body cleanly, so without this the cancel would race the success commit:
	// the run would read as succeeded with a cut-off report posted as its
	// result, and the cancellation could never be confirmed.
	//
	// It covers only that ordering. A stop that fails or finds no active run
	// moves the run to reconciliation_required (MarkCancellationUnconfirmed),
	// which this guard does not refuse: a body that then ends cleanly is
	// recorded as success, and the reconciliation marker, not this check, is
	// what tells an operator the cancellation never confirmed.
	if run.DispatchState == DispatchCancelRequested {
		return Run{}, nil, ErrRunCancelling
	}
	completedAt := params.CompletedAt.UTC()
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET status = 'succeeded',
		        summary = $2,
		        input_tokens = $3,
		        output_tokens = $4,
		        total_tokens = $5,
		        cost_micros = $6,
		        currency = $7,
		        failure_code = NULL,
		        failure_message = NULL,
		        failure_retryable = NULL,
		        dispatch_state = 'succeeded',
		        completed_at = $8,
		        updated_at = $8
		  WHERE id = $1`,
		params.RunID,
		params.Summary,
		params.Usage.InputTokens,
		params.Usage.OutputTokens,
		params.Usage.TotalTokens,
		params.Usage.CostMicros,
		params.Usage.Currency,
		completedAt,
	); err != nil {
		return Run{}, nil, errors.New("complete run")
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET status = 'in_review',
		        active_run_id = NULL,
		        updated_at = $3
		  WHERE id = $1 AND active_run_id = $2`,
		run.IssueID,
		run.ID,
		completedAt,
	); err != nil {
		return Run{}, nil, errors.New("move completed issue to review")
	}

	usageSequence, err := allocateSequence(ctx, tx, run.ID)
	if err != nil {
		return Run{}, nil, err
	}
	completedSequence, err := allocateSequence(ctx, tx, run.ID)
	if err != nil {
		return Run{}, nil, err
	}
	usageOccurredAt, err := nextEventTime(ctx, tx, run.ID, completedAt)
	if err != nil {
		return Run{}, nil, err
	}
	completedOccurredAt := usageOccurredAt.Add(time.Microsecond)
	run.Status = StatusSucceeded
	run.Sequence = completedSequence
	run.Summary = params.Summary
	run.Usage = params.Usage
	run.Failure = nil
	run.DispatchState = DispatchSucceeded
	run.CompletedAt = &completedAt
	run.UpdatedAt = completedAt

	usageBody, err := usagePayload(params.Usage)
	if err != nil {
		return Run{}, nil, err
	}
	usageEvent := runEvent(
		params.UsageEventID,
		"run.usage.updated",
		run,
		usageSequence,
		usageBody,
		usageOccurredAt,
	)
	completedBody, err := lifecyclePayload(run)
	if err != nil {
		return Run{}, nil, err
	}
	completedEvent := runEvent(
		params.CompletedEventID,
		"run.completed",
		run,
		completedSequence,
		completedBody,
		completedOccurredAt,
	)
	if err := insertPublicEvent(ctx, tx, usageEvent); err != nil {
		return Run{}, nil, err
	}
	if err := insertPublicEvent(ctx, tx, completedEvent); err != nil {
		return Run{}, nil, err
	}
	issueEvent, err := issueUpdatedEvent(
		ctx,
		tx,
		params.IssueEventID,
		run.ID,
		run.IssueID,
		completedOccurredAt.Add(time.Microsecond),
	)
	if err != nil {
		return Run{}, nil, err
	}
	if err := insertOutboxEvent(ctx, tx, issueEvent, "issue", run.IssueID); err != nil {
		return Run{}, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, nil, errors.New("commit run success")
	}
	return run, []Event{usageEvent, completedEvent, issueEvent}, nil
}

// Fail records one terminal failure. Ambiguous dispatch/stream failures retain
// a reconciliation marker but never trigger another unsafe POST.
func (repository *Repository) Fail(
	ctx context.Context,
	params FailParams,
) (Run, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin run failure")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, params.RunID)
	if err != nil {
		return Run{}, Event{}, err
	}
	if run.Terminal() {
		return Run{}, Event{}, ErrRunTerminal
	}
	dispatchState := DispatchFailed
	var reconcileAt *time.Time
	var reconcileReason *string
	if params.Reconcile {
		dispatchState = DispatchReconciliationRequired
		value := params.FailedAt.UTC()
		reconcileAt = &value
		reason := params.Failure.Code
		reconcileReason = &reason
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET status = 'failed',
		        failure_code = $2,
		        failure_message = $3,
		        failure_retryable = $4,
		        dispatch_state = $5,
		        reconciliation_required_at = $6,
		        reconciliation_reason = $7,
		        completed_at = $8,
		        updated_at = $8
		  WHERE id = $1`,
		run.ID,
		params.Failure.Code,
		params.Failure.Message,
		params.Failure.Retryable,
		string(dispatchState),
		reconcileAt,
		reconcileReason,
		params.FailedAt,
	); err != nil {
		return Run{}, Event{}, errors.New("fail run")
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET active_run_id = NULL, updated_at = $3
		  WHERE id = $1 AND active_run_id = $2`,
		run.IssueID,
		run.ID,
		params.FailedAt,
	); err != nil {
		return Run{}, Event{}, errors.New("clear failed active run")
	}
	sequence, err := allocateSequence(ctx, tx, run.ID)
	if err != nil {
		return Run{}, Event{}, err
	}
	failedAt := params.FailedAt.UTC()
	eventAt, err := nextEventTime(ctx, tx, run.ID, failedAt)
	if err != nil {
		return Run{}, Event{}, err
	}
	run.Status = StatusFailed
	run.Sequence = sequence
	run.Failure = &params.Failure
	run.DispatchState = dispatchState
	run.CompletedAt = &failedAt
	run.UpdatedAt = failedAt
	payload, err := lifecyclePayload(run)
	if err != nil {
		return Run{}, Event{}, err
	}
	event := runEvent(params.EventID, "run.failed", run, sequence, payload, eventAt)
	if err := insertPublicEvent(ctx, tx, event); err != nil {
		return Run{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, Event{}, errors.New("commit run failure")
	}
	return run, event, nil
}

// RequestCancellation records intent and claims at most one upstream stop POST.
func (repository *Repository) RequestCancellation(
	ctx context.Context,
	params CancelParams,
) (CancellationClaim, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return CancellationClaim{}, errors.New("begin run cancellation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, params.RunID)
	if err != nil {
		return CancellationClaim{}, err
	}
	if run.Status == StatusSucceeded || run.Status == StatusFailed {
		return CancellationClaim{}, ErrRunTerminal
	}
	if run.Status == StatusCancelled {
		return CancellationClaim{Run: run, UpstreamAgentID: run.UpstreamAgentID}, nil
	}
	if run.Status == StatusQueued &&
		run.DispatchState == DispatchCancelRequested &&
		run.CancelAttemptedAt == nil {
		return CancellationClaim{
			Run:             run,
			UpstreamAgentID: run.UpstreamAgentID,
			CancelLocally:   true,
		}, nil
	}
	if run.CancelAttemptedAt != nil {
		if err := tx.Commit(ctx); err != nil {
			return CancellationClaim{}, errors.New("commit existing cancellation")
		}
		return CancellationClaim{
			Run:             run,
			UpstreamAgentID: run.UpstreamAgentID,
		}, nil
	}
	cancelLocally := run.Status == StatusQueued && run.DispatchState == DispatchPending
	var attemptedAt *time.Time
	if !cancelLocally {
		value := params.RequestedAt.UTC()
		attemptedAt = &value
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET dispatch_state = 'cancel_requested',
		        dispatch_version = dispatch_version + 1,
		        cancel_requested_at = COALESCE(cancel_requested_at, $2),
		        cancel_attempted_at = $3,
		        cancel_requested_by = $4,
		        updated_at = $2
		  WHERE id = $1`,
		run.ID,
		params.RequestedAt,
		attemptedAt,
		params.RequestedBy,
	); err != nil {
		return CancellationClaim{}, errors.New("record cancellation intent")
	}
	requestedAt := params.RequestedAt.UTC()
	run.DispatchState = DispatchCancelRequested
	run.DispatchVersion++
	run.CancelRequestedAt = &requestedAt
	run.CancelAttemptedAt = attemptedAt
	run.UpdatedAt = requestedAt
	if err := tx.Commit(ctx); err != nil {
		return CancellationClaim{}, errors.New("commit cancellation intent")
	}
	return CancellationClaim{
		Run:             run,
		UpstreamAgentID: run.UpstreamAgentID,
		ShouldStop:      !cancelLocally,
		CancelLocally:   cancelLocally,
	}, nil
}

// MarkCancelled commits confirmed/local cancellation and its terminal event.
func (repository *Repository) MarkCancelled(
	ctx context.Context,
	runID, eventID uuid.UUID,
	upstreamRequestID string,
	now time.Time,
) (Run, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Run{}, Event{}, errors.New("begin cancelled run")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, runID)
	if err != nil {
		return Run{}, Event{}, err
	}
	if run.Status == StatusCancelled {
		return run, Event{}, nil
	}
	if run.Status == StatusSucceeded || run.Status == StatusFailed {
		return Run{}, Event{}, ErrRunTerminal
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE runs
		    SET status = 'cancelled',
		        dispatch_state = 'cancelled',
		        cancel_completed_at = $2,
		        upstream_request_id = COALESCE(NULLIF($3, ''), upstream_request_id),
		        completed_at = $2,
		        updated_at = $2
		  WHERE id = $1`,
		run.ID,
		now,
		upstreamRequestID,
	); err != nil {
		return Run{}, Event{}, errors.New("mark run cancelled")
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET active_run_id = NULL, updated_at = $3
		  WHERE id = $1 AND active_run_id = $2`,
		run.IssueID,
		run.ID,
		now,
	); err != nil {
		return Run{}, Event{}, errors.New("clear cancelled active run")
	}
	sequence, err := allocateSequence(ctx, tx, run.ID)
	if err != nil {
		return Run{}, Event{}, err
	}
	cancelledAt := now.UTC()
	eventAt, err := nextEventTime(ctx, tx, run.ID, cancelledAt)
	if err != nil {
		return Run{}, Event{}, err
	}
	run.Status = StatusCancelled
	run.Sequence = sequence
	run.DispatchState = DispatchCancelled
	run.CompletedAt = &cancelledAt
	run.UpdatedAt = cancelledAt
	if upstreamRequestID != "" {
		run.UpstreamRequestID = &upstreamRequestID
	}
	payload, err := lifecyclePayload(run)
	if err != nil {
		return Run{}, Event{}, err
	}
	event := runEvent(eventID, "run.cancelled", run, sequence, payload, eventAt)
	if err := insertPublicEvent(ctx, tx, event); err != nil {
		return Run{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Run{}, Event{}, errors.New("commit cancelled run")
	}
	return run, event, nil
}

// MarkCancellationUnconfirmed preserves active state and requests operator
// reconciliation. The same cancellation endpoint will not issue another POST.
func (repository *Repository) MarkCancellationUnconfirmed(
	ctx context.Context,
	runID uuid.UUID,
	now time.Time,
) error {
	if _, err := repository.Pool.Exec(
		ctx,
		`UPDATE runs
		    SET dispatch_state = 'reconciliation_required',
		        reconciliation_required_at = COALESCE(reconciliation_required_at, $2),
		        reconciliation_reason = 'cancellation-unconfirmed',
		        updated_at = $2
		  WHERE id = $1
		    AND status IN ('queued', 'running')`,
		runID,
		now,
	); err != nil {
		return errors.New("record cancellation reconciliation")
	}
	return nil
}

func (repository *Repository) appendActiveEvent(
	ctx context.Context,
	runID, eventID uuid.UUID,
	eventType string,
	payload json.RawMessage,
	now time.Time,
	mutate func(context.Context, pgx.Tx) error,
) (Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin run event")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	run, err := lockRun(ctx, tx, runID)
	if err != nil {
		return Event{}, err
	}
	if run.Terminal() || run.Status != StatusRunning {
		return Event{}, ErrRunTerminal
	}
	if mutate != nil {
		if err := mutate(ctx, tx); err != nil {
			return Event{}, errors.New("update run projection")
		}
	}
	sequence, err := allocateSequence(ctx, tx, runID)
	if err != nil {
		return Event{}, err
	}
	eventAt, err := nextEventTime(ctx, tx, runID, now)
	if err != nil {
		return Event{}, err
	}
	run.Sequence = sequence
	event := runEvent(eventID, eventType, run, sequence, payload, eventAt)
	if err := insertPublicEvent(ctx, tx, event); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, errors.New("commit run event")
	}
	return event, nil
}

func lockRun(ctx context.Context, tx pgx.Tx, runID uuid.UUID) (Run, error) {
	run, err := scanRun(tx.QueryRow(
		ctx,
		`SELECT `+runProjection+`
		   FROM runs AS r
		  WHERE r.id = $1
		  FOR UPDATE`,
		runID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, errors.New("lock run")
	}
	return run, nil
}

func runEvent(
	eventID uuid.UUID,
	eventType string,
	run Run,
	sequence int64,
	payload json.RawMessage,
	occurredAt time.Time,
) Event {
	runID := run.ID
	value := sequence
	return Event{
		ID:         eventID,
		Type:       eventType,
		OccurredAt: occurredAt.UTC(),
		BoardID:    run.BoardID,
		IssueID:    run.IssueID,
		RunID:      &runID,
		Sequence:   &value,
		Payload:    payload,
	}
}

// nextEventTime keeps board-outbox ordering consistent with run sequence at
// PostgreSQL's microsecond timestamp precision. lockRun serializes appenders.
func nextEventTime(
	ctx context.Context,
	tx pgx.Tx,
	runID uuid.UUID,
	requested time.Time,
) (time.Time, error) {
	var occurredAt time.Time
	if err := tx.QueryRow(
		ctx,
		`SELECT GREATEST(
		            $2::timestamptz,
		            COALESCE(MAX(occurred_at) + INTERVAL '1 microsecond', $2::timestamptz)
		        )
		   FROM run_events
		  WHERE run_id = $1`,
		runID,
		requested.UTC(),
	).Scan(&occurredAt); err != nil {
		return time.Time{}, errors.New("allocate run event time")
	}
	return occurredAt.UTC(), nil
}
