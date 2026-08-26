package goals

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixture struct {
	pool        *pgxpool.Pool
	now         time.Time
	userID      uuid.UUID
	workspaceID uuid.UUID
	boardID     uuid.UUID
}

func seed(t *testing.T, ctx context.Context) (*Repository, fixture) {
	t.Helper()
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	seeded := fixture{
		pool: pool, now: time.Date(2026, time.August, 25, 14, 0, 0, 0, time.UTC),
		userID: uuid.New(), workspaceID: uuid.New(), boardID: uuid.New(),
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, seeded.workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, seeded.userID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Goals', 'member', $3, $3)`,
		seeded.userID, fmt.Sprintf("%s@berry.test", seeded.userID), seeded.now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Goals', $2, $3, $4, $4)`,
		seeded.workspaceID, "goals-"+seeded.workspaceID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		seeded.workspaceID, seeded.userID, seeded.now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Goals', $3, $4, $5, $5)`,
		seeded.boardID, seeded.workspaceID, "b"+seeded.boardID.String()[:8], seeded.userID, seeded.now)
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return repository, seeded
}

func (seeded fixture) issue(t *testing.T, ctx context.Context, number int, status string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := seeded.pool.Exec(ctx,
		`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by, created_at, updated_at)
		 VALUES ($1, $2, $3, 'Goal issue', $4, 'none', 0, $5, $6, $6)`,
		id, seeded.boardID, number, status, seeded.userID, seeded.now); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	return id
}

// A goal follows draft → active → completed and never leaves a terminal
// state; each move is a fact on the workspace stream.
func TestGoalLifecycleEmitsFactsAndRefusesBackwardMoves(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	goal, created, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Title: "Launch", CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if goal.Status != StatusDraft || created.Type != "goal.created" || created.WorkspaceID != seeded.workspaceID || created.BoardID != uuid.Nil {
		t.Fatalf("created goal = %+v event = %+v", goal, created)
	}
	started, event, err := repository.Start(ctx, goal.ID, &seeded.userID, seeded.now.Add(time.Minute), nil)
	if err != nil || started.Status != StatusActive || started.StartedAt == nil || event.Type != "goal.started" {
		t.Fatalf("Start() = %+v, %+v, %v", started, event, err)
	}
	completed, event, err := repository.Complete(ctx, goal.ID, &seeded.userID, seeded.now.Add(2*time.Minute), nil)
	if err != nil || completed.Status != StatusCompleted || completed.CompletedAt == nil || event.Type != "goal.completed" {
		t.Fatalf("Complete() = %+v, %+v, %v", completed, event, err)
	}
	_, _, err = repository.Start(ctx, goal.ID, &seeded.userID, seeded.now.Add(3*time.Minute), nil)
	var transition *TransitionError
	if !errors.As(err, &transition) || !errors.Is(err, ErrInvalidTransition) || transition.From != StatusCompleted {
		t.Fatalf("reopening a completed goal = %v, want TransitionError", err)
	}
	if _, _, err := repository.Complete(ctx, goal.ID, &seeded.userID, seeded.now, nil); err != nil {
		t.Fatalf("repeating the current status must be a no-op, got %v", err)
	}
	var stored string
	if err := seeded.pool.QueryRow(ctx, `SELECT payload->'payload'->'goal'->>'status' FROM outbox_events WHERE id = $1`, event.ID).Scan(&stored); err != nil || stored != "completed" {
		t.Fatalf("stored event payload status = %q (err %v)", stored, err)
	}
}

// Progress counts the goal's linked issues, active workflows and pending
// approvals, whether the approval names the goal or one of its issues.
func TestGoalProgressCountsIssuesWorkflowsAndApprovals(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	goal, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Title: "Measure", CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	open := seeded.issue(t, ctx, 1, "todo")
	done := seeded.issue(t, ctx, 2, "done")
	for _, issueID := range []uuid.UUID{open, done} {
		if err := repository.LinkIssue(ctx, seeded.workspaceID, goal.ID, issueID, seeded.userID, seeded.now); err != nil {
			t.Fatalf("LinkIssue() error = %v", err)
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := seeded.pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO automations (id, workspace_id, goal_id, name, definition, trigger_type, status)
	      VALUES (gen_random_uuid(), $1, $2, 'Active', '{"version":"1"}'::jsonb, 'manual', 'active')`, seeded.workspaceID, goal.ID)
	exec(`INSERT INTO automations (id, workspace_id, goal_id, name, definition, trigger_type, status)
	      VALUES (gen_random_uuid(), $1, $2, 'Draft', '{"version":"1"}'::jsonb, 'manual', 'draft')`, seeded.workspaceID, goal.ID)
	exec(`INSERT INTO approvals (workspace_id, kind, title, goal_id, requested_from_role) VALUES ($1, 'plan', 'Plan', $2, 'admin')`,
		seeded.workspaceID, goal.ID)
	exec(`INSERT INTO approvals (workspace_id, kind, title, issue_id, requested_from_role) VALUES ($1, 'issue_start', 'Start', $2, 'admin')`,
		seeded.workspaceID, open)
	progress, err := repository.Progress(ctx, goal.ID)
	if err != nil {
		t.Fatalf("Progress() error = %v", err)
	}
	want := Progress{IssuesTotal: 2, IssuesDone: 1, AutomationsActive: 1, ApprovalsPending: 2}
	if progress != want {
		t.Fatalf("Progress() = %+v, want %+v", progress, want)
	}
	issues, err := repository.ListIssues(ctx, goal.ID, 10)
	if err != nil || len(issues) != 2 || issues[0].ID != open || issues[1].Status != "done" || issues[0].Identifier == "" {
		t.Fatalf("ListIssues() = %+v, %v", issues, err)
	}
	if err := repository.UnlinkIssue(ctx, goal.ID, done); err != nil {
		t.Fatalf("UnlinkIssue() error = %v", err)
	}
	if err := repository.UnlinkIssue(ctx, goal.ID, done); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second UnlinkIssue() = %v, want ErrNotFound", err)
	}
}

// Archiving hides the goal from reads and listings without destroying it,
// and the list pages by (updatedAt, id) descending.
func TestArchivedGoalsVanishFromReadsAndListsPage(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	var ids []uuid.UUID
	for index := range 3 {
		goal, _, err := repository.Create(ctx, CreateParams{
			ID: uuid.New(), WorkspaceID: seeded.workspaceID, Title: fmt.Sprintf("Goal %d", index),
			CreatedBy: seeded.userID, CreatedAt: seeded.now.Add(time.Duration(index) * time.Second),
		})
		if err != nil {
			t.Fatalf("Create() error = %v", err)
		}
		ids = append(ids, goal.ID)
	}
	first, err := repository.List(ctx, seeded.workspaceID, ListFilter{}, nil, 2)
	if err != nil || len(first) != 2 || first[0].ID != ids[2] || first[1].ID != ids[1] {
		t.Fatalf("first page = %+v, %v", first, err)
	}
	second, err := repository.List(ctx, seeded.workspaceID, ListFilter{}, &Cursor{UpdatedAt: first[1].UpdatedAt, ID: first[1].ID}, 2)
	if err != nil || len(second) != 1 || second[0].ID != ids[0] {
		t.Fatalf("second page = %+v, %v", second, err)
	}
	if _, err := repository.Archive(ctx, ids[0], seeded.userID, seeded.now.Add(time.Hour), nil); err != nil {
		t.Fatalf("Archive() error = %v", err)
	}
	if _, err := repository.Get(ctx, ids[0]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() after archive = %v, want ErrNotFound", err)
	}
	remaining, err := repository.List(ctx, seeded.workspaceID, ListFilter{Query: "goal"}, nil, 10)
	if err != nil || len(remaining) != 2 {
		t.Fatalf("List() after archive = %d goals, %v", len(remaining), err)
	}
	title := "Renamed"
	updated, event, err := repository.Update(ctx, ids[1], Patch{Title: &title, DescriptionSet: true}, seeded.userID, seeded.now.Add(2*time.Hour), nil)
	if err != nil || updated.Title != "Renamed" || event.Type != "goal.updated" {
		t.Fatalf("Update() = %+v, %+v, %v", updated, event, err)
	}
}
