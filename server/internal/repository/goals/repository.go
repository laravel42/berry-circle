package goals

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// Repository owns the hand-written pgx boundary for goals.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("goal repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

type database interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

const goalProjection = `
	goal.id, goal.workspace_id, goal.project_id, goal.title, goal.description,
	goal.status, goal.source, goal.source_prompt, goal.created_by,
	goal.created_at, goal.updated_at, goal.started_at, goal.completed_at`

type rowScanner interface {
	Scan(...any) error
}

func scanGoal(row rowScanner) (Goal, error) {
	var (
		goal   Goal
		status string
		source string
	)
	if err := row.Scan(
		&goal.ID, &goal.WorkspaceID, &goal.ProjectID, &goal.Title, &goal.Description,
		&status, &source, &goal.SourcePrompt, &goal.CreatedBy,
		&goal.CreatedAt, &goal.UpdatedAt, &goal.StartedAt, &goal.CompletedAt,
	); err != nil {
		return Goal{}, err
	}
	goal.Status = Status(status)
	goal.Source = Source(source)
	return goal, nil
}

// Get returns one live goal.
func (repository *Repository) Get(ctx context.Context, goalID uuid.UUID) (Goal, error) {
	return getGoal(ctx, repository.Pool, goalID, false)
}

func getGoal(ctx context.Context, queryer database, goalID uuid.UUID, lock bool) (Goal, error) {
	if goalID == uuid.Nil {
		return Goal{}, ErrNotFound
	}
	statement := `SELECT ` + goalProjection + ` FROM goals AS goal WHERE goal.id = $1 AND goal.deleted_at IS NULL`
	if lock {
		statement += ` FOR UPDATE`
	}
	goal, err := scanGoal(queryer.QueryRow(ctx, statement, goalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Goal{}, ErrNotFound
	}
	if err != nil {
		return Goal{}, errors.New("get goal")
	}
	return goal, nil
}

// WorkspaceID resolves the workspace a live goal belongs to.
func (repository *Repository) WorkspaceID(ctx context.Context, goalID uuid.UUID) (uuid.UUID, error) {
	goal, err := repository.Get(ctx, goalID)
	if err != nil {
		return uuid.Nil, err
	}
	return goal.WorkspaceID, nil
}

// List returns one over-fetched stable page, most recently updated first.
func (repository *Repository) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *Cursor,
	limit int,
) ([]Goal, error) {
	if workspaceID == uuid.Nil || limit < 1 {
		return nil, errors.New("goal list configuration is invalid")
	}
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.UpdatedAt, after.ID
	}
	projectEnabled := filter.ProjectID != nil
	var projectID any
	if projectEnabled {
		projectID = *filter.ProjectID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+goalProjection+`
		   FROM goals AS goal
		  WHERE goal.workspace_id = $1
		    AND goal.deleted_at IS NULL
		    AND ($2 = '' OR goal.status = $2)
		    AND (NOT $3::boolean OR goal.project_id = $4::uuid)
		    AND ($5 = '' OR goal.title ILIKE '%' || $5 || '%')
		    AND (NOT $6::boolean OR
		        (goal.updated_at, goal.id) < ($7::timestamptz, $8::uuid))
		  ORDER BY goal.updated_at DESC, goal.id DESC
		  LIMIT $9`,
		workspaceID,
		string(filter.Status),
		projectEnabled,
		projectID,
		strings.TrimSpace(filter.Query),
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list goals")
	}
	defer rows.Close()
	result := make([]Goal, 0, limit)
	for rows.Next() {
		goal, err := scanGoal(rows)
		if err != nil {
			return nil, errors.New("scan goal")
		}
		result = append(result, goal)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate goals")
	}
	return result, nil
}

// Create writes one goal and its goal.created fact in one transaction.
func (repository *Repository) Create(ctx context.Context, params CreateParams) (Goal, Event, error) {
	if params.ID == uuid.Nil || params.WorkspaceID == uuid.Nil || params.Title == "" ||
		params.CreatedBy == uuid.Nil || params.CreatedAt.IsZero() {
		return Goal{}, Event{}, errors.New("goal creation parameters are invalid")
	}
	if params.Status == "" {
		params.Status = StatusDraft
	}
	if params.Source == "" {
		params.Source = SourceManual
	}
	if !params.Status.Valid() || params.Status == StatusCompleted {
		return Goal{}, Event{}, errors.New("goal creation status is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Goal{}, Event{}, errors.New("begin goal creation")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	goal, event, err := CreateIn(ctx, tx, params)
	if err != nil {
		return Goal{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Goal{}, Event{}, errors.New("commit goal creation")
	}
	return goal, event, nil
}

// CreateIn is Create inside a caller's transaction, which is how a plan
// compile and a generated plan write their goal beside everything else.
func CreateIn(ctx context.Context, tx database, params CreateParams) (Goal, Event, error) {
	if params.Status == "" {
		params.Status = StatusDraft
	}
	if params.Source == "" {
		params.Source = SourceManual
	}
	var startedAt *time.Time
	if params.Status == StatusActive {
		value := params.CreatedAt.UTC()
		startedAt = &value
	}
	goal, err := scanGoal(tx.QueryRow(
		ctx,
		`INSERT INTO goals AS goal (
		    id, workspace_id, project_id, title, description, status, source,
		    source_prompt, created_by, created_at, updated_at, started_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)
		 RETURNING `+goalProjection,
		params.ID, params.WorkspaceID, params.ProjectID, params.Title, params.Description,
		string(params.Status), string(params.Source), params.SourcePrompt, params.CreatedBy,
		params.CreatedAt.UTC(), startedAt,
	))
	if err != nil {
		return Goal{}, Event{}, classifyWrite("insert goal", err)
	}
	event, err := writeGoalEvent(ctx, tx, "goal.created", goal, nil, actorKey(params.CreatedBy), goal.CreatedAt, params.NewID)
	if err != nil {
		return Goal{}, Event{}, err
	}
	return goal, event, nil
}

// Update applies a patch under a row lock and emits goal.updated naming the
// changed fields.
func (repository *Repository) Update(
	ctx context.Context,
	goalID uuid.UUID,
	patch Patch,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Goal, Event, error) {
	if patch.Empty() {
		return Goal{}, Event{}, errors.New("goal patch is empty")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Goal{}, Event{}, errors.New("begin goal update")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getGoal(ctx, tx, goalID, true)
	if err != nil {
		return Goal{}, Event{}, err
	}
	var changed []string
	if patch.Title != nil && *patch.Title != current.Title {
		changed = append(changed, "title")
	}
	if patch.DescriptionSet {
		changed = append(changed, "description")
	}
	if patch.ProjectSet {
		changed = append(changed, "project")
	}
	goal, err := scanGoal(tx.QueryRow(
		ctx,
		`UPDATE goals AS goal
		    SET title = COALESCE($2, goal.title),
		        description = CASE WHEN $3::boolean THEN $4 ELSE goal.description END,
		        project_id = CASE WHEN $5::boolean THEN $6::uuid ELSE goal.project_id END,
		        updated_at = $7
		  WHERE goal.id = $1
		  RETURNING `+goalProjection,
		goalID, patch.Title, patch.DescriptionSet, patch.Description,
		patch.ProjectSet, patch.ProjectID, now.UTC(),
	))
	if err != nil {
		return Goal{}, Event{}, classifyWrite("update goal", err)
	}
	event, err := writeGoalEvent(ctx, tx, "goal.updated", goal, changed, actorKey(actorID), now, newID)
	if err != nil {
		return Goal{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Goal{}, Event{}, errors.New("commit goal update")
	}
	return goal, event, nil
}

// Transition moves a goal along its lifecycle. Start, Complete and Cancel are
// the named moves; blocked is the dispatcher's. A move the lifecycle does not
// allow returns a TransitionError naming both ends.
func (repository *Repository) Transition(
	ctx context.Context,
	goalID uuid.UUID,
	to Status,
	actor *uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Goal, Event, error) {
	if !to.Valid() {
		return Goal{}, Event{}, errors.New("goal status is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Goal{}, Event{}, errors.New("begin goal transition")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getGoal(ctx, tx, goalID, true)
	if err != nil {
		return Goal{}, Event{}, err
	}
	if current.Status == to {
		// Asking for the state the goal is already in is not a conflict.
		return current, Event{}, tx.Commit(ctx)
	}
	if !CanTransition(current.Status, to) {
		return Goal{}, Event{}, &TransitionError{From: current.Status, To: to}
	}
	goal, err := scanGoal(tx.QueryRow(
		ctx,
		`UPDATE goals AS goal
		    SET status = $2,
		        started_at = CASE WHEN $2 IN ('active', 'blocked') THEN COALESCE(goal.started_at, $3) ELSE goal.started_at END,
		        completed_at = CASE WHEN $2 = 'completed' THEN $3 ELSE NULL END,
		        updated_at = $3
		  WHERE goal.id = $1
		  RETURNING `+goalProjection,
		goalID, string(to), now.UTC(),
	))
	if err != nil {
		return Goal{}, Event{}, classifyWrite("transition goal", err)
	}
	topic := "goal.updated"
	switch to {
	case StatusActive:
		if current.StartedAt == nil {
			topic = "goal.started"
		}
	case StatusCompleted:
		topic = "goal.completed"
	case StatusCancelled:
		topic = "goal.cancelled"
	}
	var key *core.ActorKey
	if actor != nil {
		key = actorKey(*actor)
	}
	event, err := writeGoalEvent(ctx, tx, topic, goal, []string{"status"}, key, now, newID)
	if err != nil {
		return Goal{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Goal{}, Event{}, errors.New("commit goal transition")
	}
	return goal, event, nil
}

// PlanIn is what a plan compile does to its goal inside the compile
// transaction: adopt the plan's title, description and project, and move the
// goal to planned. A goal that already moved on (active, blocked) keeps its
// status — the compile adds work to it, it does not restart it. Terminal
// goals refuse. Returns the goal.updated fact for the caller to publish.
func PlanIn(
	ctx context.Context,
	tx database,
	goalID uuid.UUID,
	title string,
	description *string,
	projectID *uuid.UUID,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Goal, Event, error) {
	if goalID == uuid.Nil || strings.TrimSpace(title) == "" {
		return Goal{}, Event{}, errors.New("goal plan parameters are invalid")
	}
	current, err := getGoal(ctx, tx, goalID, true)
	if err != nil {
		return Goal{}, Event{}, err
	}
	if current.Status.Terminal() {
		return Goal{}, Event{}, &TransitionError{From: current.Status, To: StatusPlanned}
	}
	status := current.Status
	if status == StatusDraft {
		status = StatusPlanned
	}
	goal, err := scanGoal(tx.QueryRow(
		ctx,
		`UPDATE goals AS goal
		    SET title = $2,
		        description = COALESCE($3, goal.description),
		        project_id = COALESCE($4::uuid, goal.project_id),
		        status = $5,
		        updated_at = $6
		  WHERE goal.id = $1
		  RETURNING `+goalProjection,
		goalID, strings.TrimSpace(title), description, projectID, string(status), now.UTC(),
	))
	if err != nil {
		return Goal{}, Event{}, classifyWrite("plan goal", err)
	}
	changed := []string{"title"}
	if description != nil {
		changed = append(changed, "description")
	}
	if projectID != nil {
		changed = append(changed, "project")
	}
	if status != current.Status {
		changed = append(changed, "status")
	}
	event, err := writeGoalEvent(ctx, tx, "goal.updated", goal, changed, actorKey(actorID), now, newID)
	if err != nil {
		return Goal{}, Event{}, err
	}
	return goal, event, nil
}

// Start moves a goal to active.
func (repository *Repository) Start(ctx context.Context, goalID uuid.UUID, actor *uuid.UUID, now time.Time, newID func() uuid.UUID) (Goal, Event, error) {
	return repository.Transition(ctx, goalID, StatusActive, actor, now, newID)
}

// Complete moves a goal to completed.
func (repository *Repository) Complete(ctx context.Context, goalID uuid.UUID, actor *uuid.UUID, now time.Time, newID func() uuid.UUID) (Goal, Event, error) {
	return repository.Transition(ctx, goalID, StatusCompleted, actor, now, newID)
}

// Cancel moves a goal to cancelled.
func (repository *Repository) Cancel(ctx context.Context, goalID uuid.UUID, actor *uuid.UUID, now time.Time, newID func() uuid.UUID) (Goal, Event, error) {
	return repository.Transition(ctx, goalID, StatusCancelled, actor, now, newID)
}

// Archive soft-deletes a goal. Its issues keep their link rows but the goal
// no longer resolves; nothing is destroyed.
func (repository *Repository) Archive(
	ctx context.Context,
	goalID uuid.UUID,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin goal archive")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	goal, err := getGoal(ctx, tx, goalID, true)
	if err != nil {
		return Event{}, err
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE goals SET deleted_at = $2, updated_at = $2 WHERE id = $1`,
		goalID, now.UTC(),
	); err != nil {
		return Event{}, classifyWrite("archive goal", err)
	}
	event, err := writeGoalEvent(ctx, tx, "goal.archived", goal, nil, actorKey(actorID), now, newID)
	if err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, errors.New("commit goal archive")
	}
	return event, nil
}

// LinkIssue attaches an issue to a goal, replacing any earlier goal: an issue
// belongs to at most one goal. The trigger refuses an issue from another
// workspace (ErrNotFound).
func (repository *Repository) LinkIssue(
	ctx context.Context,
	workspaceID, goalID, issueID, actorID uuid.UUID,
	now time.Time,
) error {
	return LinkIssueIn(ctx, repository.Pool, workspaceID, goalID, issueID, actorID, now)
}

// LinkIssueIn is LinkIssue inside a caller's transaction.
func LinkIssueIn(
	ctx context.Context,
	execer database,
	workspaceID, goalID, issueID, actorID uuid.UUID,
	now time.Time,
) error {
	if workspaceID == uuid.Nil || goalID == uuid.Nil || issueID == uuid.Nil {
		return errors.New("goal link parameters are invalid")
	}
	var linkedBy *uuid.UUID
	if actorID != uuid.Nil {
		linkedBy = &actorID
	}
	if _, err := execer.Exec(
		ctx,
		`INSERT INTO goal_issues (workspace_id, issue_id, goal_id, linked_by, created_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (issue_id) DO UPDATE
		     SET goal_id = EXCLUDED.goal_id,
		         workspace_id = EXCLUDED.workspace_id,
		         linked_by = EXCLUDED.linked_by,
		         created_at = EXCLUDED.created_at`,
		workspaceID, issueID, goalID, linkedBy, now.UTC(),
	); err != nil {
		return classifyWrite("link goal issue", err)
	}
	return nil
}

// UnlinkIssue detaches an issue. ErrNotFound when it was not linked.
func (repository *Repository) UnlinkIssue(ctx context.Context, goalID, issueID uuid.UUID) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM goal_issues WHERE goal_id = $1 AND issue_id = $2`,
		goalID, issueID,
	)
	if err != nil {
		return fmt.Errorf("unlink goal issue: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ClearIssueGoal detaches an issue from whatever goal it serves. An issue
// with no goal is left as it is: clearing is idempotent.
func (repository *Repository) ClearIssueGoal(ctx context.Context, issueID uuid.UUID) error {
	if issueID == uuid.Nil {
		return errors.New("goal clear needs an issue")
	}
	if _, err := repository.Pool.Exec(ctx, `DELETE FROM goal_issues WHERE issue_id = $1`, issueID); err != nil {
		return fmt.Errorf("clear issue goal: %w", err)
	}
	return nil
}

// ListIssues returns the live issues linked to a goal, oldest link first.
func (repository *Repository) ListIssues(ctx context.Context, goalID uuid.UUID, limit int) ([]LinkedIssue, error) {
	if goalID == uuid.Nil || limit < 1 {
		return nil, errors.New("goal issue list configuration is invalid")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT issue.id, berry_issue_identifier(board.workspace_id, issue.number),
		        issue.title, issue.status::text, link.created_at
		   FROM goal_issues AS link
		   JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
		   JOIN boards AS board ON board.id = issue.board_id
		  WHERE link.goal_id = $1
		  ORDER BY link.created_at ASC, issue.number ASC, issue.id ASC
		  LIMIT $2`,
		goalID, limit,
	)
	if err != nil {
		return nil, errors.New("list goal issues")
	}
	defer rows.Close()
	result := make([]LinkedIssue, 0, limit)
	for rows.Next() {
		var (
			issue  LinkedIssue
			status string
		)
		if err := rows.Scan(&issue.ID, &issue.Identifier, &issue.Title, &status, &issue.LinkedAt); err != nil {
			return nil, errors.New("scan goal issue")
		}
		issue.Status = wireStatus(status)
		result = append(result, issue)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate goal issues")
	}
	return result, nil
}

// Progress counts the goal's work, automation and pending decisions.
// Approvals count whether they target the goal directly or one of its issues.
func (repository *Repository) Progress(ctx context.Context, goalID uuid.UUID) (Progress, error) {
	if goalID == uuid.Nil {
		return Progress{}, ErrNotFound
	}
	var progress Progress
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT
		    (SELECT count(*) FROM goal_issues AS link
		       JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
		      WHERE link.goal_id = $1),
		    (SELECT count(*) FROM goal_issues AS link
		       JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
		      WHERE link.goal_id = $1 AND issue.status = 'done'),
		    (SELECT count(*) FROM goal_issues AS link
		       JOIN issues AS issue ON issue.id = link.issue_id AND issue.deleted_at IS NULL
		      WHERE link.goal_id = $1 AND issue.status = 'cancelled'),
		    (SELECT count(*) FROM automations AS automation
		      WHERE automation.goal_id = $1 AND automation.status = 'active'),
		    (SELECT count(*) FROM approvals AS approval
		      WHERE approval.status = 'pending'
		        AND (approval.goal_id = $1
		             OR approval.issue_id IN (SELECT issue_id FROM goal_issues WHERE goal_id = $1)))`,
		goalID,
	).Scan(
		&progress.IssuesTotal, &progress.IssuesDone, &progress.IssuesCancelled,
		&progress.AutomationsActive, &progress.ApprovalsPending,
	); err != nil {
		return Progress{}, errors.New("read goal progress")
	}
	return progress, nil
}

func actorKey(userID uuid.UUID) *core.ActorKey {
	if userID == uuid.Nil {
		return nil
	}
	return &core.ActorKey{Type: "user", ID: userID}
}

func wireStatus(status string) string {
	switch status {
	case "in_progress":
		return "inProgress"
	case "in_review":
		return "inReview"
	default:
		return status
	}
}

func classifyWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrNotFound
		case "23505", "23P01", "23514":
			return ErrConflict
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// ensure ledger stays referenced for the Event alias.
var _ = ledger.OutboxScopeWorkspace
