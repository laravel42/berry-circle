package plans

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("PLAN_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("PLAN_TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// fixture creates a workspace, board, and an agent, returning their ids.
func fixture(t *testing.T, pool *pgxpool.Pool) (ws, board, agent, user uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	user, ws, board = uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("fixture %q: %v", sql[:40], err)
		}
	}
	exec(`INSERT INTO users (id,email,name,role) VALUES ($1,$2,'T','admin')`,
		user, user.String()+"@berry.test")
	exec(`INSERT INTO workspaces (id,name,slug,created_by) VALUES ($1,'W',$2,$3)`,
		ws, "w"+ws.String()[:8], user)
	exec(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'admin')`, ws, user)
	exec(`INSERT INTO boards (id,workspace_id,name,slug,created_by) VALUES ($1,$2,'B',$3,$4)`,
		board, ws, "b"+board.String()[:8], user)
	agent = uuid.New()
	exec(`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status)
	      VALUES ($1,$2,gen_random_uuid(),'Bot','available')`, agent, ws)
	return ws, board, agent, user
}

func sampleDraft(ws, board, agent, user uuid.UUID) Draft {
	desc := "Do the thing"
	return Draft{
		WorkspaceID: ws, BoardID: board,
		ProjectName: "Ship it", Summary: "User wants X",
		ProposedBy: agent, BriefedBy: user,
		Milestones: []MilestoneDraft{{Name: "M1"}, {Name: "M2"}},
		Tasks: []TaskDraft{
			{Title: "T1", Description: &desc, AgentID: &agent, MilestoneAt: intp(0)},
			{Title: "T2", AgentID: &agent, MilestoneAt: intp(1)},
		},
	}
}

func intp(v int) *int { return &v }

// The whole point of the gate: a drafted plan must be invisible to agents.
func TestDraftedWorkIsNotDispatchable(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)

	plan, err := repo.CreateDraft(ctx, sampleDraft(ws, board, agent, user), time.Now())
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if plan.Status != StatusPendingApproval {
		t.Fatalf("status = %s, want pending_approval", plan.Status)
	}

	var backlog int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issues i JOIN plan_issues p ON p.issue_id=i.id
		  WHERE p.plan_id=$1 AND i.status='backlog'`, plan.ID).Scan(&backlog); err != nil {
		t.Fatal(err)
	}
	if backlog != 2 {
		t.Fatalf("drafted tasks in backlog = %d, want 2", backlog)
	}

	// The database itself must refuse to queue unapproved work.
	var issueID uuid.UUID
	if err := pool.QueryRow(ctx,
		`SELECT issue_id FROM plan_issues WHERE plan_id=$1 LIMIT 1`, plan.ID).Scan(&issueID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE issues SET status='todo' WHERE id=$1`, issueID); err == nil {
		t.Fatal("an unapproved plan's task was allowed into todo")
	}
}

func TestApprovalReleasesWork(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)

	plan, err := repo.CreateDraft(ctx, sampleDraft(ws, board, agent, user), time.Now())
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	approved, err := repo.Approve(ctx, ws, plan.ID, user, "looks good", time.Now())
	if err != nil {
		t.Fatalf("Approve: %v", err)
	}
	if approved.TaskCount != 2 {
		t.Fatalf("released %d tasks, want 2", approved.TaskCount)
	}

	var todo int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issues i JOIN plan_issues p ON p.issue_id=i.id
		  WHERE p.plan_id=$1 AND i.status='todo'`, plan.ID).Scan(&todo); err != nil {
		t.Fatal(err)
	}
	if todo != 2 {
		t.Fatalf("todo tasks = %d, want 2", todo)
	}

	var projectStatus string
	if err := pool.QueryRow(ctx,
		`SELECT status FROM projects WHERE id=$1`, plan.ProjectID).Scan(&projectStatus); err != nil {
		t.Fatal(err)
	}
	if projectStatus != "active" {
		t.Fatalf("project status = %s, want active", projectStatus)
	}

	// Double approval is a no-op, not an error.
	if _, err := repo.Approve(ctx, ws, plan.ID, user, "", time.Now()); err != nil {
		t.Fatalf("second Approve: %v", err)
	}
}

func TestRejectionReleasesNothing(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)

	plan, err := repo.CreateDraft(ctx, sampleDraft(ws, board, agent, user), time.Now())
	if err != nil {
		t.Fatalf("CreateDraft: %v", err)
	}
	if err := repo.Reject(ctx, ws, plan.ID, user, "wrong scope", time.Now()); err != nil {
		t.Fatalf("Reject: %v", err)
	}
	var todo int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM issues i JOIN plan_issues p ON p.issue_id=i.id
		  WHERE p.plan_id=$1 AND i.status<>'backlog'`, plan.ID).Scan(&todo); err != nil {
		t.Fatal(err)
	}
	if todo != 0 {
		t.Fatalf("%d tasks escaped a rejected plan", todo)
	}
	if _, err := repo.Approve(ctx, ws, plan.ID, user, "", time.Now()); err == nil {
		t.Fatal("a rejected plan was approvable")
	}
}

// An empty plan would tell the user work was queued when none was.
func TestEmptyPlanIsRejected(t *testing.T) {
	pool := testPool(t)
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)
	draft := sampleDraft(ws, board, agent, user)
	draft.Tasks = nil
	if _, err := repo.CreateDraft(context.Background(), draft, time.Now()); err == nil {
		t.Fatal("an empty plan was accepted")
	}
}
