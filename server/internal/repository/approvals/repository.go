package approvals

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Repository owns the hand-written pgx boundary for approvals.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("approval repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

type database interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// approvalProjection joins the gated issue so a reader shows "BER-5" without a
// second request. The join is LEFT so a deleted issue hides its identifier
// rather than the approval.
const approvalProjection = `
	approval.id, approval.workspace_id, approval.kind, approval.risk, approval.title,
	approval.description, approval.goal_id, approval.plan_id, approval.issue_id,
	approval.automation_id, approval.automation_run_id, approval.automation_step_run_id,
	approval.audit_event_id, approval.requested_from_user_id, approval.requested_from_role,
	approval.requested_by_type, approval.requested_by, approval.status, approval.decision_note,
	approval.resolved_by, approval.requested_at, approval.expires_at, approval.resolved_at,
	approval.created_at, approval.updated_at,
	issue.id, berry_issue_identifier(board.workspace_id, issue.number), issue.title`

const approvalSource = `
	FROM approvals AS approval
	LEFT JOIN issues AS issue ON issue.id = approval.issue_id AND issue.deleted_at IS NULL
	LEFT JOIN boards AS board ON board.id = issue.board_id`

type rowScanner interface {
	Scan(...any) error
}

func scanApproval(row rowScanner) (Approval, error) {
	var (
		approval        Approval
		kind, risk      string
		requestedByType string
		status          string
		role            *string
		issueID         *uuid.UUID
		identifier      *string
		title           *string
	)
	if err := row.Scan(
		&approval.ID, &approval.WorkspaceID, &kind, &risk, &approval.Title,
		&approval.Description, &approval.GoalID, &approval.PlanID, &approval.IssueID,
		&approval.AutomationID, &approval.AutomationRunID, &approval.AutomationStepRunID,
		&approval.AuditEventID, &approval.RequestedFromUserID, &role,
		&requestedByType, &approval.RequestedBy, &status, &approval.DecisionNote,
		&approval.ResolvedBy, &approval.RequestedAt, &approval.ExpiresAt, &approval.ResolvedAt,
		&approval.CreatedAt, &approval.UpdatedAt,
		&issueID, &identifier, &title,
	); err != nil {
		return Approval{}, err
	}
	approval.Kind = Kind(kind)
	approval.Risk = Risk(risk)
	approval.RequestedByType = ActorType(requestedByType)
	approval.Status = Status(status)
	if role != nil {
		approval.RequestedFromRole = *role
	}
	if issueID != nil && identifier != nil && title != nil {
		approval.Issue = &IssueRef{ID: *issueID, Identifier: *identifier, Title: *title}
	}
	return approval, nil
}

// Get returns one approval.
func (repository *Repository) Get(ctx context.Context, approvalID uuid.UUID) (Approval, error) {
	return getApproval(ctx, repository.Pool, approvalID, false)
}

func getApproval(ctx context.Context, queryer database, approvalID uuid.UUID, lock bool) (Approval, error) {
	if approvalID == uuid.Nil {
		return Approval{}, ErrNotFound
	}
	statement := `SELECT ` + approvalProjection + approvalSource + ` WHERE approval.id = $1`
	if lock {
		statement += ` FOR UPDATE OF approval`
	}
	approval, err := scanApproval(queryer.QueryRow(ctx, statement, approvalID))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrNotFound
	}
	if err != nil {
		return Approval{}, errors.New("get approval")
	}
	return approval, nil
}

// Create writes one request and its approval.requested fact.
func (repository *Repository) Create(ctx context.Context, params CreateParams) (Approval, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Approval{}, Event{}, errors.New("begin approval request")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	approval, event, err := CreateIn(ctx, tx, params)
	if err != nil {
		return Approval{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Approval{}, Event{}, errors.New("commit approval request")
	}
	return approval, event, nil
}

// CreateIn is Create inside a caller's transaction, which is how a plan
// compile writes issue_start gates beside the issues they gate.
func CreateIn(ctx context.Context, tx database, params CreateParams) (Approval, Event, error) {
	switch {
	case params.ID == uuid.Nil, params.WorkspaceID == uuid.Nil, params.Title == "", params.RequestedAt.IsZero():
		return Approval{}, Event{}, errors.New("approval request parameters are invalid")
	case !params.Kind.Valid():
		return Approval{}, Event{}, errors.New("approval kind is invalid")
	case params.RequestedFromUserID == nil && !identity.Role(params.RequestedFromRole).Valid():
		return Approval{}, Event{}, errors.New("approval needs an addressee: a user or a role")
	case params.RequestedFromRole == string(identity.RoleViewer):
		return Approval{}, Event{}, errors.New("viewers cannot resolve approvals")
	case params.ExpiresAt != nil && !params.ExpiresAt.After(params.RequestedAt):
		return Approval{}, Event{}, errors.New("approval expiry must follow the request")
	}
	if params.Risk == "" {
		params.Risk = RiskMedium
	}
	if params.RequestedByType == "" {
		params.RequestedByType = ActorSystem
		if params.RequestedBy != nil {
			params.RequestedByType = ActorUser
		}
	}
	var role *string
	if params.RequestedFromRole != "" {
		role = &params.RequestedFromRole
	}
	var approvalID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO approvals (
		    id, workspace_id, kind, risk, title, description, goal_id, plan_id, issue_id,
		    automation_id, automation_run_id, automation_step_run_id, audit_event_id,
		    requested_from_user_id, requested_from_role, requested_by_type, requested_by,
		    status, requested_at, expires_at, created_at, updated_at
		 ) VALUES (
		    $1, $2, $3, $4, $5, $6, $7, $8, $9,
		    $10, $11, $12, $13,
		    $14, $15, $16, $17,
		    'pending', $18, $19, $18, $18
		 ) RETURNING id`,
		params.ID, params.WorkspaceID, string(params.Kind), string(params.Risk), params.Title,
		params.Description, params.GoalID, params.PlanID, params.IssueID,
		params.AutomationID, params.AutomationRunID, params.AutomationStepRunID, params.AuditEventID,
		params.RequestedFromUserID, role, string(params.RequestedByType), params.RequestedBy,
		params.RequestedAt.UTC(), params.ExpiresAt,
	).Scan(&approvalID); err != nil {
		return Approval{}, Event{}, classifyWrite("insert approval", err)
	}
	approval, err := getApproval(ctx, tx, approvalID, false)
	if err != nil {
		return Approval{}, Event{}, err
	}
	var actor *core.ActorKey
	if params.RequestedBy != nil {
		actor = &core.ActorKey{Type: string(params.RequestedByType), ID: *params.RequestedBy}
	}
	event, err := writeApprovalEvent(ctx, tx, "approval.requested", approval, actor, params.RequestedAt, params.NewID)
	if err != nil {
		return Approval{}, Event{}, err
	}
	return approval, event, nil
}

// List returns one over-fetched stable page, newest request first.
func (repository *Repository) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	filter ListFilter,
	after *Cursor,
	limit int,
) ([]Approval, error) {
	if workspaceID == uuid.Nil || limit < 1 {
		return nil, errors.New("approval list configuration is invalid")
	}
	afterEnabled := after != nil
	var afterTime, afterID any
	if after != nil {
		afterTime, afterID = after.RequestedAt, after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+approvalProjection+approvalSource+`
		  WHERE approval.workspace_id = $1
		    AND ($2 = '' OR approval.status = $2)
		    AND ($3 = '' OR approval.kind = $3)
		    AND ($4::uuid IS NULL OR approval.goal_id = $4::uuid)
		    AND ($5::uuid IS NULL OR approval.issue_id = $5::uuid)
		    AND ($6::uuid IS NULL OR approval.automation_id = $6::uuid)
		    AND (NOT $7::boolean OR
		        (approval.requested_at, approval.id) < ($8::timestamptz, $9::uuid))
		  ORDER BY approval.requested_at DESC, approval.id DESC
		  LIMIT $10`,
		workspaceID, string(filter.Status), string(filter.Kind),
		filter.GoalID, filter.IssueID, filter.AutomationID,
		afterEnabled, afterTime, afterID, limit,
	)
	if err != nil {
		return nil, errors.New("list approvals")
	}
	defer rows.Close()
	return collect(rows, limit)
}

// PendingFor lists the open approvals a person may resolve: those addressed
// to them, and those addressed to a role their own role satisfies.
func (repository *Repository) PendingFor(
	ctx context.Context,
	workspaceID, userID uuid.UUID,
	role identity.Role,
	limit int,
) ([]Approval, error) {
	if workspaceID == uuid.Nil || userID == uuid.Nil || limit < 1 {
		return nil, errors.New("pending approval configuration is invalid")
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+approvalProjection+approvalSource+`
		  WHERE approval.workspace_id = $1
		    AND approval.status = 'pending'
		    AND (approval.requested_from_user_id = $2
		         OR (approval.requested_from_user_id IS NULL
		             AND approval.requested_from_role = ANY($3::text[])))
		  ORDER BY approval.requested_at DESC, approval.id DESC
		  LIMIT $4`,
		workspaceID, userID, rolesSatisfiedBy(role), limit,
	)
	if err != nil {
		return nil, errors.New("list pending approvals")
	}
	defer rows.Close()
	return collect(rows, limit)
}

// rolesSatisfiedBy lists the roles an actor may act for: their own and every
// weaker one.
func rolesSatisfiedBy(role identity.Role) []string {
	var roles []string
	for _, candidate := range []identity.Role{identity.RoleMember, identity.RoleAdmin, identity.RoleOwner} {
		if identity.RoleAtLeast(role, candidate) {
			roles = append(roles, string(candidate))
		}
	}
	if roles == nil {
		roles = []string{}
	}
	return roles
}

func collect(rows pgx.Rows, limit int) ([]Approval, error) {
	result := make([]Approval, 0, limit)
	for rows.Next() {
		approval, err := scanApproval(rows)
		if err != nil {
			return nil, errors.New("scan approval")
		}
		result = append(result, approval)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate approvals")
	}
	return result, nil
}

// LatestForIssue returns the newest approval of one kind on an issue, which
// is the row the 020 trigger consults.
func (repository *Repository) LatestForIssue(ctx context.Context, issueID uuid.UUID, kind Kind) (Approval, error) {
	if issueID == uuid.Nil {
		return Approval{}, ErrNotFound
	}
	approval, err := scanApproval(repository.Pool.QueryRow(
		ctx,
		`SELECT `+approvalProjection+approvalSource+`
		  WHERE approval.issue_id = $1 AND approval.kind = $2
		  ORDER BY approval.requested_at DESC, approval.id DESC
		  LIMIT 1`,
		issueID, string(kind),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Approval{}, ErrNotFound
	}
	if err != nil {
		return Approval{}, errors.New("get latest issue approval")
	}
	return approval, nil
}

// Resolve records one decision under a row lock. Approving an issue_start
// gate releases its issue from backlog to todo in the same transaction —
// the only path that moves a gated issue — and returns the issue events
// beside the approval event so both publish after commit.
func (repository *Repository) Resolve(
	ctx context.Context,
	approvalID uuid.UUID,
	resolution Resolution,
) (Approval, []Event, error) {
	if approvalID == uuid.Nil || resolution.ActorID == uuid.Nil || resolution.Now.IsZero() {
		return Approval{}, nil, errors.New("approval resolution parameters are invalid")
	}
	if resolution.Decision != DecisionApproved && resolution.Decision != DecisionRejected {
		return Approval{}, nil, errors.New("approval decision is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Approval{}, nil, errors.New("begin approval resolution")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	current, err := getApproval(ctx, tx, approvalID, true)
	if err != nil {
		return Approval{}, nil, err
	}
	if !current.Pending() {
		return Approval{}, nil, ErrAlreadyResolved
	}
	now := resolution.Now.UTC()
	if _, err := tx.Exec(
		ctx,
		`UPDATE approvals
		    SET status = $2, decision_note = NULLIF($3, ''), resolved_by = $4,
		        resolved_at = $5, updated_at = $5
		  WHERE id = $1`,
		approvalID, string(resolution.Decision), resolution.Note, resolution.ActorID, now,
	); err != nil {
		return Approval{}, nil, classifyWrite("resolve approval", err)
	}
	approval, err := getApproval(ctx, tx, approvalID, false)
	if err != nil {
		return Approval{}, nil, err
	}
	actor := &core.ActorKey{Type: "user", ID: resolution.ActorID}
	topic := "approval.approved"
	if resolution.Decision == DecisionRejected {
		topic = "approval.rejected"
	}
	event, err := writeApprovalEvent(ctx, tx, topic, approval, actor, now, resolution.NewID)
	if err != nil {
		return Approval{}, nil, err
	}
	events := []Event{event}
	if approval.Kind == KindIssueStart && resolution.Decision == DecisionApproved && approval.IssueID != nil {
		released, err := releaseIssue(ctx, tx, *approval.IssueID, actor, now.Add(time.Microsecond), resolution.NewID)
		if err != nil {
			return Approval{}, nil, err
		}
		events = append(events, released...)
	}
	if err := tx.Commit(ctx); err != nil {
		return Approval{}, nil, errors.New("commit approval resolution")
	}
	return approval, events, nil
}

// ResolvePlanIn approves the pending kind=plan approval of a plan inside the
// caller's transaction, which is how a compile started by the addressee (or
// a stronger role) closes the request it is fulfilling. A plan with no
// pending approval yields nil, nil, nil.
func ResolvePlanIn(
	ctx context.Context,
	tx database,
	planID uuid.UUID,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) (*Approval, *Event, error) {
	if planID == uuid.Nil || actorID == uuid.Nil || now.IsZero() {
		return nil, nil, errors.New("plan approval resolution parameters are invalid")
	}
	var approvalID uuid.UUID
	err := tx.QueryRow(
		ctx,
		`SELECT id FROM approvals
		  WHERE plan_id = $1 AND kind = 'plan' AND status = 'pending'
		  ORDER BY requested_at DESC, id DESC
		  LIMIT 1
		  FOR UPDATE`,
		planID,
	).Scan(&approvalID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, errors.New("find pending plan approval")
	}
	resolvedAt := now.UTC()
	if _, err := tx.Exec(
		ctx,
		`UPDATE approvals
		    SET status = 'approved', resolved_by = $2, resolved_at = $3, updated_at = $3
		  WHERE id = $1`,
		approvalID, actorID, resolvedAt,
	); err != nil {
		return nil, nil, classifyWrite("resolve plan approval", err)
	}
	approval, err := getApproval(ctx, tx, approvalID, false)
	if err != nil {
		return nil, nil, err
	}
	event, err := writeApprovalEvent(ctx, tx, "approval.approved", approval, &core.ActorKey{Type: "user", ID: actorID}, resolvedAt, newID)
	if err != nil {
		return nil, nil, err
	}
	return &approval, &event, nil
}

// releaseIssue moves a gated issue out of backlog: to todo when nothing it
// depends on is still open, to blocked otherwise, so the dependency release
// finishes the job when the last blocker completes. An issue a person already
// moved elsewhere keeps their choice: approval grants permission to start, it
// does not overwrite decisions. The 010 plan gate can still refuse.
func releaseIssue(
	ctx context.Context,
	tx pgx.Tx,
	issueID uuid.UUID,
	actor *core.ActorKey,
	now time.Time,
	newID func() uuid.UUID,
) ([]Event, error) {
	blocked, err := core.HasOpenBlockers(ctx, tx, issueID)
	if err != nil {
		return nil, err
	}
	target := "todo"
	if blocked {
		target = "blocked"
	}
	tag, err := tx.Exec(
		ctx,
		`UPDATE issues SET status = $3::issue_status, updated_at = $2
		  WHERE id = $1 AND status = 'backlog' AND deleted_at IS NULL`,
		issueID, now, target,
	)
	if err != nil {
		return nil, classifyWrite("release gated issue", err)
	}
	if tag.RowsAffected() == 0 {
		return nil, nil
	}
	issueEvents, err := core.RecordIssueEvents(ctx, tx, core.IssueEventParams{
		IssueID:        issueID,
		Kind:           core.IssueEventUpdated,
		ChangedFields:  []string{"status"},
		PreviousStatus: "backlog",
		Actor:          actor,
		OccurredAt:     now,
		NewID:          newID,
	})
	if err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(issueEvents))
	for _, issueEvent := range issueEvents {
		events = append(events, Event{
			ID:          issueEvent.ID,
			Type:        issueEvent.Type,
			OccurredAt:  issueEvent.OccurredAt,
			WorkspaceID: issueEvent.WorkspaceID,
			BoardID:     issueEvent.BoardID,
			IssueID:     issueEvent.IssueID,
			Payload:     issueEvent.Payload,
		})
	}
	return events, nil
}

// ExpireDue closes pending approvals whose deadline passed, at most limit at
// a time, skipping rows another sweep holds. Each one emits approval.expired
// so a waiting workflow step can fail with APPROVAL_EXPIRED.
func (repository *Repository) ExpireDue(
	ctx context.Context,
	now time.Time,
	limit int,
	newID func() uuid.UUID,
) ([]Approval, []Event, error) {
	if limit < 1 || limit > 1000 {
		return nil, nil, errors.New("approval expiry limit is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, nil, errors.New("begin approval expiry")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(
		ctx,
		`SELECT id FROM approvals
		  WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= $1
		  ORDER BY expires_at ASC, id ASC
		  LIMIT $2
		  FOR UPDATE SKIP LOCKED`,
		now.UTC(), limit,
	)
	if err != nil {
		return nil, nil, errors.New("select due approvals")
	}
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, errors.New("scan due approval")
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, errors.New("iterate due approvals")
	}
	expired := make([]Approval, 0, len(ids))
	events := make([]Event, 0, len(ids))
	for index, id := range ids {
		if _, err := tx.Exec(
			ctx,
			`UPDATE approvals SET status = 'expired', resolved_at = $2, updated_at = $2 WHERE id = $1`,
			id, now.UTC(),
		); err != nil {
			return nil, nil, classifyWrite("expire approval", err)
		}
		approval, err := getApproval(ctx, tx, id, false)
		if err != nil {
			return nil, nil, err
		}
		event, err := writeApprovalEvent(ctx, tx, "approval.expired", approval, nil,
			now.UTC().Add(time.Duration(index)*time.Microsecond), newID)
		if err != nil {
			return nil, nil, err
		}
		expired = append(expired, approval)
		events = append(events, event)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, errors.New("commit approval expiry")
	}
	return expired, events, nil
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
		case "23001":
			return ErrApprovalRequired
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}
