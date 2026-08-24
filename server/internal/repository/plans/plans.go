// Package plans owns orchestrator-authored plans and the human approval gate.
//
// The product model is: the user briefs the orchestrator, the orchestrator
// drafts a plan, the user approves it, and only then do agents start work.
// After that the user is pulled back in only when a task is blocked or waiting
// for review.
//
// Two invariants shape everything here.
//
// A plan is written whole or not at all. A half-written plan — a project with
// three of its seven tasks — would be presented to a user as if it were the
// orchestrator's complete proposal, and they would approve something nobody
// intended. Draft is therefore one transaction.
//
// Nothing runs before approval. Drafted tasks are created in `backlog`, which
// intake never selects, and migration 010 additionally blocks any planned issue
// from reaching `todo` while its plan is unapproved. Approval is the single
// transition that moves them, so an unapproved plan is inert by construction
// rather than by remembering to check.
package plans

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository owns the hand-written pgx boundary for plans.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("plan repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

// Plan lifecycle states.
const (
	StatusDraft           = "draft"
	StatusPendingApproval = "pending_approval"
	StatusApproved        = "approved"
	StatusRejected        = "rejected"
	StatusSuperseded      = "superseded"
)

var (
	ErrNotFound     = errors.New("plan not found")
	ErrNotPending   = errors.New("plan is not awaiting approval")
	ErrPlanConflict = errors.New("project already has an open plan")
)

// TaskDraft is one proposed task. Agent is the orchestrator's routing decision,
// made while planning rather than by a later sweep, so the user approves who
// does what as well as what gets done.
type TaskDraft struct {
	Title       string
	Description *string
	Priority    string
	MilestoneAt *int
	AgentID     *uuid.UUID
	Labels      []uuid.UUID
}

// MilestoneDraft is one proposed milestone, in intended order.
type MilestoneDraft struct {
	Name        string
	Description *string
	TargetDate  *time.Time
}

// Draft is a complete proposal: one project, its milestones, and its tasks.
type Draft struct {
	WorkspaceID uuid.UUID
	BoardID     uuid.UUID
	ProjectName string
	ProjectGoal *string
	Summary     string
	ProposedBy  uuid.UUID
	BriefedBy   uuid.UUID
	Milestones  []MilestoneDraft
	Tasks       []TaskDraft
}

// Plan is a stored plan header.
type Plan struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	ProjectID   uuid.UUID
	Status      string
	Summary     *string
	TaskCount   int
	CreatedAt   time.Time
}

// CreateDraft writes a whole proposal in one transaction and leaves it awaiting
// approval.
//
// Tasks are created in `backlog` deliberately. That is the status intake never
// selects, so between drafting and approval the plan is visible to the user and
// invisible to every agent.
func (repository *Repository) CreateDraft(
	ctx context.Context,
	draft Draft,
	now time.Time,
) (Plan, error) {
	if err := validateDraft(draft); err != nil {
		return Plan{}, err
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Plan{}, errors.New("begin plan draft")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var projectID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO projects (workspace_id, name, description, status, created_at, updated_at)
		 VALUES ($1, $2, $3, 'planned', $4, $4)
		 RETURNING id`,
		draft.WorkspaceID,
		draft.ProjectName,
		draft.ProjectGoal,
		now,
	).Scan(&projectID); err != nil {
		return Plan{}, fmt.Errorf("insert plan project: %w", err)
	}

	var planID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO plans (
		    workspace_id, project_id, status, summary, proposed_by, briefed_by,
		    created_at, updated_at
		 ) VALUES ($1, $2, 'pending_approval', $3, $4, $5, $6, $6)
		 RETURNING id`,
		draft.WorkspaceID,
		projectID,
		draft.Summary,
		draft.ProposedBy,
		draft.BriefedBy,
		now,
	).Scan(&planID); err != nil {
		return Plan{}, fmt.Errorf("insert plan: %w", err)
	}

	milestoneIDs := make([]uuid.UUID, 0, len(draft.Milestones))
	for index, milestone := range draft.Milestones {
		var milestoneID uuid.UUID
		if err := tx.QueryRow(
			ctx,
			`INSERT INTO milestones (
			    workspace_id, project_id, name, description, position,
			    status, target_date, created_at, updated_at
			 ) VALUES ($1, $2, $3, $4, $5, 'planned', $6, $7, $7)
			 RETURNING id`,
			draft.WorkspaceID,
			projectID,
			milestone.Name,
			milestone.Description,
			index,
			milestone.TargetDate,
			now,
		).Scan(&milestoneID); err != nil {
			return Plan{}, fmt.Errorf("insert plan milestone: %w", err)
		}
		milestoneIDs = append(milestoneIDs, milestoneID)
	}

	for _, task := range draft.Tasks {
		issueID, err := insertPlannedIssue(ctx, tx, draft, projectID, task, now)
		if err != nil {
			return Plan{}, err
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO plan_issues (workspace_id, issue_id, plan_id, created_at)
			 VALUES ($1, $2, $3, $4)`,
			draft.WorkspaceID, issueID, planID, now,
		); err != nil {
			return Plan{}, fmt.Errorf("link plan issue: %w", err)
		}
		if task.MilestoneAt != nil {
			index := *task.MilestoneAt
			if index < 0 || index >= len(milestoneIDs) {
				return Plan{}, errors.New("plan task references an unknown milestone")
			}
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO issue_milestone_links
				    (workspace_id, issue_id, milestone_id, created_at)
				 VALUES ($1, $2, $3, $4)`,
				draft.WorkspaceID, issueID, milestoneIDs[index], now,
			); err != nil {
				return Plan{}, fmt.Errorf("link plan milestone: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return Plan{}, errors.New("commit plan draft")
	}
	return Plan{
		ID:          planID,
		WorkspaceID: draft.WorkspaceID,
		ProjectID:   projectID,
		Status:      StatusPendingApproval,
		Summary:     &draft.Summary,
		TaskCount:   len(draft.Tasks),
		CreatedAt:   now,
	}, nil
}

// insertPlannedIssue writes one drafted task in `backlog` with its board number
// allocated the same atomic way the rest of the product does it.
func insertPlannedIssue(
	ctx context.Context,
	tx pgx.Tx,
	draft Draft,
	projectID uuid.UUID,
	task TaskDraft,
	now time.Time,
) (uuid.UUID, error) {
	var number int32
	if err := tx.QueryRow(
		ctx,
		`UPDATE boards SET issue_counter = issue_counter + 1
		  WHERE id = $1 RETURNING issue_counter`,
		draft.BoardID,
	).Scan(&number); err != nil {
		return uuid.Nil, fmt.Errorf("allocate plan issue number: %w", err)
	}

	priority := task.Priority
	if priority == "" {
		priority = "none"
	}

	var issueID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO issues (
		    board_id, number, title, description, status, priority,
		    sort_order, assignee_type, assignee_id, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, 'backlog', $5, $2, $6, $7, $8, $8)
		 RETURNING id`,
		draft.BoardID,
		number,
		task.Title,
		task.Description,
		priority,
		assigneeType(task.AgentID),
		task.AgentID,
		now,
	).Scan(&issueID); err != nil {
		return uuid.Nil, fmt.Errorf("insert plan issue: %w", err)
	}

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO issue_project_links (workspace_id, issue_id, project_id, created_at)
		 VALUES ($1, $2, $3, $4)`,
		draft.WorkspaceID, issueID, projectID, now,
	); err != nil {
		return uuid.Nil, fmt.Errorf("link plan project: %w", err)
	}

	for _, labelID := range task.Labels {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO issue_label_memberships
			    (workspace_id, issue_id, label_id, created_at)
			 VALUES ($1, $2, $3, $4)
			 ON CONFLICT DO NOTHING`,
			draft.WorkspaceID, issueID, labelID, now,
		); err != nil {
			return uuid.Nil, fmt.Errorf("label plan issue: %w", err)
		}
	}
	return issueID, nil
}

func assigneeType(agentID *uuid.UUID) *string {
	if agentID == nil {
		return nil
	}
	value := "agent"
	return &value
}

func validateDraft(draft Draft) error {
	switch {
	case draft.WorkspaceID == uuid.Nil, draft.BoardID == uuid.Nil:
		return errors.New("plan draft scope is invalid")
	case draft.ProposedBy == uuid.Nil, draft.BriefedBy == uuid.Nil:
		return errors.New("plan draft actors are required")
	case draft.ProjectName == "":
		return errors.New("plan draft project name is required")
	case len(draft.Tasks) == 0:
		// A plan with no work is not a plan, and approving one would leave the
		// user believing something was queued.
		return errors.New("plan draft must contain at least one task")
	case len(draft.Tasks) > 500 || len(draft.Milestones) > 100:
		return errors.New("plan draft is too large")
	}
	for _, task := range draft.Tasks {
		if task.Title == "" {
			return errors.New("plan task title is required")
		}
	}
	for _, milestone := range draft.Milestones {
		if milestone.Name == "" {
			return errors.New("plan milestone name is required")
		}
	}
	return nil
}

// Approve is the gate. It is the only transition that makes planned work
// dispatchable, and it is one transaction: the plan, its project, and every one
// of its tasks move together, so a partially-approved plan cannot exist.
//
// Ordering matters. The plan is flipped to `approved` first, because migration
// 010's trigger reads plan status when an issue moves to `todo` — moving the
// issues first would be rejected by Berry's own safety guard.
//
// Only tasks still in `backlog` are advanced. Anything a human already moved,
// cancelled, or blocked keeps the state they chose; approval grants permission
// to start, it does not overwrite decisions.
func (repository *Repository) Approve(
	ctx context.Context,
	workspaceID, planID, approvedBy uuid.UUID,
	note string,
	now time.Time,
) (Plan, error) {
	if workspaceID == uuid.Nil || planID == uuid.Nil || approvedBy == uuid.Nil {
		return Plan{}, errors.New("plan approval parameters are invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Plan{}, errors.New("begin plan approval")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var plan Plan
	var status string
	if err := tx.QueryRow(
		ctx,
		`SELECT id, workspace_id, project_id, status, summary, created_at
		   FROM plans
		  WHERE id = $1 AND workspace_id = $2
		  FOR UPDATE`,
		planID, workspaceID,
	).Scan(
		&plan.ID, &plan.WorkspaceID, &plan.ProjectID,
		&status, &plan.Summary, &plan.CreatedAt,
	); errors.Is(err, pgx.ErrNoRows) {
		return Plan{}, ErrNotFound
	} else if err != nil {
		return Plan{}, errors.New("load plan for approval")
	}

	// Approving twice is a no-op rather than an error: a user who double-clicks
	// should not see a failure for a decision that already took effect.
	if status == StatusApproved {
		plan.Status = StatusApproved
		return plan, tx.Commit(ctx)
	}
	if status != StatusPendingApproval {
		return Plan{}, ErrNotPending
	}

	if _, err := tx.Exec(
		ctx,
		`UPDATE plans
		    SET status = 'approved', approved_by = $3, approved_at = $4,
		        decision_note = NULLIF($5, ''), updated_at = $4
		  WHERE id = $1 AND workspace_id = $2`,
		planID, workspaceID, approvedBy, now, note,
	); err != nil {
		return Plan{}, errors.New("record plan approval")
	}

	if _, err := tx.Exec(
		ctx,
		`UPDATE projects SET status = 'active', updated_at = $3
		  WHERE id = $1 AND workspace_id = $2 AND status = 'planned'`,
		plan.ProjectID, workspaceID, now,
	); err != nil {
		return Plan{}, errors.New("activate plan project")
	}

	var released int64
	tag, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET status = 'todo', updated_at = $3
		  WHERE status = 'backlog'
		    AND id IN (
		        SELECT issue_id FROM plan_issues
		         WHERE plan_id = $1 AND workspace_id = $2
		    )`,
		planID, workspaceID, now,
	)
	if err != nil {
		return Plan{}, fmt.Errorf("release plan tasks: %w", err)
	}
	released = tag.RowsAffected()

	if err := tx.Commit(ctx); err != nil {
		return Plan{}, errors.New("commit plan approval")
	}
	plan.Status = StatusApproved
	plan.TaskCount = int(released)
	return plan, nil
}

// Reject closes a plan without releasing any work. The drafted tasks are left
// in `backlog` rather than deleted: the user asked for something, and the
// orchestrator's attempt at it is more useful as a starting point for the next
// draft than as a hole in the history.
func (repository *Repository) Reject(
	ctx context.Context,
	workspaceID, planID, rejectedBy uuid.UUID,
	note string,
	now time.Time,
) error {
	if workspaceID == uuid.Nil || planID == uuid.Nil || rejectedBy == uuid.Nil {
		return errors.New("plan rejection parameters are invalid")
	}
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE plans
		    SET status = 'rejected', decision_note = NULLIF($4, ''), updated_at = $5
		  WHERE id = $1 AND workspace_id = $2 AND status = $3`,
		planID, workspaceID, StatusPendingApproval, note, now,
	)
	if err != nil {
		return errors.New("record plan rejection")
	}
	if tag.RowsAffected() == 0 {
		return ErrNotPending
	}
	return nil
}

// PendingApproval lists the plans waiting on a human. This is one of only two
// places the product asks for the user's attention, the other being a blocked
// or in-review task, so it is a first-class query rather than a filter.
func (repository *Repository) PendingApproval(
	ctx context.Context,
	workspaceID uuid.UUID,
	limit int,
) ([]Plan, error) {
	if workspaceID == uuid.Nil {
		return nil, errors.New("plan workspace is required")
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT plan.id, plan.workspace_id, plan.project_id, plan.status,
		        plan.summary, plan.created_at,
		        (SELECT count(*) FROM plan_issues AS link
		          WHERE link.plan_id = plan.id
		            AND link.workspace_id = plan.workspace_id) AS task_count
		   FROM plans AS plan
		  WHERE plan.workspace_id = $1 AND plan.status = $2
		  ORDER BY plan.created_at DESC, plan.id
		  LIMIT $3`,
		workspaceID, StatusPendingApproval, limit,
	)
	if err != nil {
		return nil, errors.New("list pending plans")
	}
	defer rows.Close()

	plans := make([]Plan, 0, limit)
	for rows.Next() {
		var plan Plan
		var count int64
		if err := rows.Scan(
			&plan.ID, &plan.WorkspaceID, &plan.ProjectID, &plan.Status,
			&plan.Summary, &plan.CreatedAt, &count,
		); err != nil {
			return nil, errors.New("scan pending plan")
		}
		plan.TaskCount = int(count)
		plans = append(plans, plan)
	}
	if rows.Err() != nil {
		return nil, errors.New("read pending plans")
	}
	return plans, nil
}
