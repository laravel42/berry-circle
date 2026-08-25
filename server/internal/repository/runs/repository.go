package runs

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Repository owns the hand-written pgx boundary until an allowed sqlc toolchain
// can regenerate the foundation snapshot.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("run repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

// Get returns one Berry run without exposing provider identifiers publicly.
func (repository *Repository) Get(ctx context.Context, id uuid.UUID) (Run, error) {
	if repository == nil || repository.Pool == nil || id == uuid.Nil {
		return Run{}, ErrNotFound
	}
	result, err := scanRun(repository.Pool.QueryRow(
		ctx,
		`SELECT `+runProjection+` FROM runs AS r WHERE r.id = $1`,
		id,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Run{}, ErrNotFound
	}
	if err != nil {
		return Run{}, errors.New("get run")
	}
	return result, nil
}

// List returns one over-fetched stable page for a previously resolved issue.
func (repository *Repository) List(
	ctx context.Context,
	filter ListFilter,
) ([]Run, error) {
	if repository == nil || repository.Pool == nil ||
		filter.IssueID == uuid.Nil || filter.Limit < 1 {
		return nil, errors.New("run list configuration is invalid")
	}
	afterEnabled := filter.After != nil
	var afterTime any
	var afterID any
	if filter.After != nil {
		afterTime = filter.After.CreatedAt
		afterID = filter.After.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runProjection+`
		   FROM runs AS r
		  WHERE r.issue_id = $1
		    AND ($2 = '' OR r.status::text = $2)
		    AND (NOT $3::boolean OR
		        (r.created_at, r.id) < ($4::timestamptz, $5::uuid))
		  ORDER BY r.created_at DESC, r.id DESC
		  LIMIT $6`,
		filter.IssueID,
		string(filter.Status),
		afterEnabled,
		afterTime,
		afterID,
		filter.Limit,
	)
	if err != nil {
		return nil, errors.New("list runs")
	}
	defer rows.Close()
	result := make([]Run, 0, filter.Limit)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate runs")
	}
	return result, nil
}

// ListByBoard returns one over-fetched stable page for a previously resolved board.
func (repository *Repository) ListByBoard(
	ctx context.Context,
	filter BoardListFilter,
) ([]Run, error) {
	if repository == nil || repository.Pool == nil ||
		filter.BoardID == uuid.Nil || filter.Limit < 1 {
		return nil, errors.New("board run list configuration is invalid")
	}
	afterEnabled := filter.After != nil
	var afterTime any
	var afterID any
	if filter.After != nil {
		afterTime = filter.After.CreatedAt
		afterID = filter.After.ID
	}
	agentEnabled := filter.AgentID != uuid.Nil
	var agentID any
	if agentEnabled {
		agentID = filter.AgentID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+runProjection+`
		   FROM runs AS r
		  WHERE r.board_id = $1
		    AND ($2 = '' OR r.status::text = $2)
		    AND (NOT $3::boolean OR r.agent_id = $4::uuid)
		    AND (NOT $5::boolean OR
		        (r.created_at, r.id) < ($6::timestamptz, $7::uuid))
		  ORDER BY r.created_at DESC, r.id DESC
		  LIMIT $8`,
		filter.BoardID,
		string(filter.Status),
		agentEnabled,
		agentID,
		afterEnabled,
		afterTime,
		afterID,
		filter.Limit,
	)
	if err != nil {
		return nil, errors.New("list board runs")
	}
	defer rows.Close()
	result := make([]Run, 0, filter.Limit)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate board runs")
	}
	return result, nil
}

// ResolveIssueID accepts the same UUID or case-insensitive identifier shape as
// the issue resource.
func (repository *Repository) ResolveIssueID(
	ctx context.Context,
	reference string,
) (uuid.UUID, error) {
	if repository == nil || repository.Pool == nil {
		return uuid.Nil, errors.New("run repository pool is nil")
	}
	if id, err := core.ParseUUID(reference); err == nil {
		var found uuid.UUID
		if err := repository.Pool.QueryRow(
			ctx,
			`SELECT id FROM issues WHERE id = $1 AND deleted_at IS NULL`,
			id,
		).Scan(&found); errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ErrNotFound
		} else if err != nil {
			return uuid.Nil, errors.New("resolve issue")
		}
		return found, nil
	}
	slug, number, ok := splitIssueReference(reference)
	if !ok {
		return uuid.Nil, ErrNotFound
	}
	var found uuid.UUID
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT i.id
		   FROM issues AS i
		   JOIN boards AS b ON b.id = i.board_id
		  WHERE lower(b.slug) = lower($1) AND i.number = $2
		    AND i.deleted_at IS NULL`,
		slug,
		number,
	).Scan(&found); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNotFound
	} else if err != nil {
		return uuid.Nil, errors.New("resolve issue")
	}
	return found, nil
}

// BoardExists validates the board stream scope.
func (repository *Repository) BoardExists(
	ctx context.Context,
	boardID uuid.UUID,
) (bool, error) {
	if repository == nil || repository.Pool == nil || boardID == uuid.Nil {
		return false, nil
	}
	var exists bool
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT EXISTS(SELECT 1 FROM boards WHERE id = $1)`,
		boardID,
	).Scan(&exists); err != nil {
		return false, errors.New("check board")
	}
	return exists, nil
}

const runProjection = `
	r.id, r.issue_id, r.board_id, r.agent_id, r.upstream_agent_id,
	r.status::text, r.sequence, r.summary, r.output,
	r.input_tokens, r.output_tokens, r.total_tokens, r.cost_micros, r.currency,
	r.failure_code, r.failure_message, r.failure_retryable,
	r.dispatch_state, r.dispatch_version, r.upstream_request_id, r.request_id,
	r.cancel_requested_at, r.cancel_attempted_at,
	r.created_at, r.started_at, r.completed_at, r.updated_at`

type rowScanner interface {
	Scan(...any) error
}

func scanRun(row rowScanner) (Run, error) {
	var (
		result           Run
		status           string
		dispatchState    string
		upstreamAgentID  *string
		failureCode      *string
		failureMessage   *string
		failureRetryable *bool
	)
	if err := row.Scan(
		&result.ID,
		&result.IssueID,
		&result.BoardID,
		&result.AgentID,
		&upstreamAgentID,
		&status,
		&result.Sequence,
		&result.Summary,
		&result.Output,
		&result.Usage.InputTokens,
		&result.Usage.OutputTokens,
		&result.Usage.TotalTokens,
		&result.Usage.CostMicros,
		&result.Usage.Currency,
		&failureCode,
		&failureMessage,
		&failureRetryable,
		&dispatchState,
		&result.DispatchVersion,
		&result.UpstreamRequestID,
		&result.RequestID,
		&result.CancelRequestedAt,
		&result.CancelAttemptedAt,
		&result.CreatedAt,
		&result.StartedAt,
		&result.CompletedAt,
		&result.UpdatedAt,
	); err != nil {
		return Run{}, err
	}
	result.Status = Status(status)
	result.DispatchState = DispatchState(dispatchState)
	if upstreamAgentID != nil {
		id, err := uuid.Parse(*upstreamAgentID)
		if err != nil || id == uuid.Nil {
			return Run{}, errors.New("scan run: invalid upstream agent mapping")
		}
		result.UpstreamAgentID = id
	}
	if failureCode != nil && failureMessage != nil {
		result.Failure = &Failure{
			Code:      *failureCode,
			Message:   *failureMessage,
			Retryable: failureRetryable != nil && *failureRetryable,
		}
	}
	return result, nil
}

func splitIssueReference(reference string) (string, int32, bool) {
	index := strings.LastIndex(reference, "-")
	if index < 1 || index == len(reference)-1 {
		return "", 0, false
	}
	number, err := strconv.ParseInt(reference[index+1:], 10, 32)
	if err != nil || number < 1 {
		return "", 0, false
	}
	slug := reference[:index]
	if strings.TrimSpace(slug) != slug || slug == "" {
		return "", 0, false
	}
	return slug, int32(number), true
}

func wrap(operation string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// PromotableRunRow is what artifact promotion needs to know about a run.
type PromotableRunRow struct {
	AgentSlug   string
	StartedAt   time.Time
	CompletedAt time.Time
	Succeeded   bool
}

// PromotableRun resolves a run to the runtime workspace holding its output.
//
// The agent's name is what identifies that workspace, because the runtime keys
// its directories by name rather than by the id Berry uses everywhere else.
func (repository *Repository) PromotableRun(
	ctx context.Context,
	runID uuid.UUID,
) (PromotableRunRow, error) {
	var (
		row         PromotableRunRow
		status      string
		startedAt   *time.Time
		completedAt *time.Time
	)
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT agent.name, run.status::text, run.started_at, run.completed_at
		   FROM runs AS run
		   JOIN agents AS agent ON agent.id = run.agent_id
		  WHERE run.id = $1`,
		runID,
	).Scan(&row.AgentSlug, &status, &startedAt, &completedAt); err != nil {
		return PromotableRunRow{}, fmt.Errorf("load promotable run: %w", err)
	}
	row.Succeeded = status == "succeeded"
	if startedAt != nil {
		row.StartedAt = *startedAt
	}
	if completedAt != nil {
		row.CompletedAt = *completedAt
	}
	return row, nil
}

// RunsAwaitingPromotion lists recent successful runs that produced no
// artifacts, newest first.
//
// Promotion happens when a run finishes, which leaves nothing to recover a run
// whose promotion never ran — the worker was down, object storage was briefly
// unavailable, or the run predates the feature. Without this the outputs of
// such a run are orphaned permanently: the files sit in the runtime's scratch
// space and no later run will ever claim them, because each run only promotes
// files from its own window.
//
// Bounded by time and count so a worker start does not walk the entire history.
func (repository *Repository) RunsAwaitingPromotion(
	ctx context.Context,
	since time.Time,
	limit int,
) ([]uuid.UUID, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT run.id
		   FROM runs AS run
		  WHERE run.status = 'succeeded'
		    AND run.completed_at IS NOT NULL
		    AND run.completed_at >= $1
		    AND NOT EXISTS (
		        SELECT 1 FROM attachments AS attachment
		         WHERE attachment.run_id = run.id
		    )
		  ORDER BY run.completed_at DESC
		  LIMIT $2`,
		since.UTC(), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("list runs awaiting promotion: %w", err)
	}
	defer rows.Close()

	ids := make([]uuid.UUID, 0, limit)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan run awaiting promotion: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
