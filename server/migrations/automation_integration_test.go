package migrations

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// planningFixture is the minimum a gated issue needs: a person, a workspace
// they belong to, a board on it and one issue in backlog.
type planningFixture struct {
	userID      uuid.UUID
	workspaceID uuid.UUID
	boardID     uuid.UUID
	issueID     uuid.UUID
}

func seedPlanningFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) planningFixture {
	t.Helper()
	fixture := planningFixture{
		userID:      uuid.New(),
		workspaceID: uuid.New(),
		boardID:     uuid.New(),
		issueID:     uuid.New(),
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, 'Planning', 'admin')`,
		fixture.userID, fmt.Sprintf("%s@berry.test", fixture.userID))
	exec(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Planning', $2, $3)`,
		fixture.workspaceID, "plan-"+fixture.workspaceID.String()[:8], fixture.userID)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
		fixture.workspaceID, fixture.userID)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by) VALUES ($1, $2, 'Planning', $3, $4)`,
		fixture.boardID, fixture.workspaceID, "b"+fixture.boardID.String()[:8], fixture.userID)
	exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by)
	      VALUES ($1, $2, 1, 'Gated', 'backlog', 'none', 1000, $3)`,
		fixture.issueID, fixture.boardID, fixture.userID)
	return fixture
}

func sqlState(err error) string {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		return postgresError.Code
	}
	return ""
}

// The whole reason approvals exist: while the latest issue_start approval is
// pending the database itself refuses to queue the issue, with the same
// restrict_violation the plan gate raises so one Go classifier covers both.
// Once approved the very same statement goes through.
func TestPendingIssueStartApprovalBlocksTodoUntilApproved(t *testing.T) {
	ctx, pool := applyAll(t)
	fixture := seedPlanningFixture(t, ctx, pool)

	approvalID := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO approvals (id, workspace_id, kind, title, issue_id, requested_from_role)
		 VALUES ($1, $2, 'issue_start', 'Start Gated', $3, 'admin')`,
		approvalID, fixture.workspaceID, fixture.issueID); err != nil {
		t.Fatalf("insert approval: %v", err)
	}
	_, err := pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, fixture.issueID)
	if code := sqlState(err); code != "23001" {
		t.Fatalf("todo with a pending approval: err = %v (sqlstate %q), want 23001", err, code)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE approvals SET status = 'approved', resolved_by = $2, resolved_at = now() WHERE id = $1`,
		approvalID, fixture.userID); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, fixture.issueID); err != nil {
		t.Fatalf("todo after approval: %v", err)
	}
	var status string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM issues WHERE id = $1`, fixture.issueID).Scan(&status); err != nil || status != "todo" {
		t.Fatalf("status = %q (err %v), want todo", status, err)
	}
}

// 020 adds a second BEFORE trigger on issues.status. The 010 plan gate must
// keep firing for orchestrator briefs beside it.
func TestPlanGateStillBlocksUnapprovedOrchestratorPlans(t *testing.T) {
	ctx, pool := applyAll(t)
	fixture := seedPlanningFixture(t, ctx, pool)

	projectID, planID := uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO projects (id, workspace_id, name, status) VALUES ($1, $2, 'Brief', 'planned')`,
		projectID, fixture.workspaceID)
	exec(`INSERT INTO plans (id, workspace_id, project_id, status, briefed_by)
	      VALUES ($1, $2, $3, 'pending_approval', $4)`,
		planID, fixture.workspaceID, projectID, fixture.userID)
	exec(`INSERT INTO plan_issues (workspace_id, issue_id, plan_id) VALUES ($1, $2, $3)`,
		fixture.workspaceID, fixture.issueID, planID)
	_, err := pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, fixture.issueID)
	if code := sqlState(err); code != "23001" {
		t.Fatalf("todo under an unapproved plan: err = %v (sqlstate %q), want 23001", err, code)
	}
}

// A dependency edge is refused when it would close a cycle (every issue in the
// cycle would wait forever) or when either end lives in another workspace.
func TestIssueDependencyTriggerRefusesCyclesAndCrossWorkspaceEdges(t *testing.T) {
	ctx, pool := applyAll(t)
	fixture := seedPlanningFixture(t, ctx, pool)
	second, third := uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by)
	      VALUES ($1, $2, 2, 'Second', 'backlog', 'none', 1000, $3)`, second, fixture.boardID, fixture.userID)
	exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by)
	      VALUES ($1, $2, 3, 'Third', 'backlog', 'none', 1000, $3)`, third, fixture.boardID, fixture.userID)
	exec(`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id) VALUES ($1, $2, $3)`,
		fixture.workspaceID, second, fixture.issueID)
	exec(`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id) VALUES ($1, $2, $3)`,
		fixture.workspaceID, third, second)

	_, err := pool.Exec(ctx,
		`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id) VALUES ($1, $2, $3)`,
		fixture.workspaceID, fixture.issueID, third)
	if code := sqlState(err); code != "23514" {
		t.Fatalf("closing a cycle: err = %v (sqlstate %q), want 23514", err, code)
	}

	foreign := seedPlanningFixture(t, ctx, pool)
	_, err = pool.Exec(ctx,
		`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id) VALUES ($1, $2, $3)`,
		fixture.workspaceID, fixture.issueID, foreign.issueID)
	if code := sqlState(err); code != "23503" {
		t.Fatalf("cross-workspace edge: err = %v (sqlstate %q), want 23503", err, code)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id) VALUES ($1, $2, $3)`,
		foreign.workspaceID, fixture.issueID, second)
	if code := sqlState(err); code != "23503" {
		t.Fatalf("edge under the wrong workspace: err = %v (sqlstate %q), want 23503", err, code)
	}
}

// AI plans are goal-scoped and project-less so plans_one_open_per_project_key
// never blocks a second plan for the same project; the check makes the two
// shapes disjoint.
func TestPlanScopeCheckKeepsBriefsAndGeneratedPlansDisjoint(t *testing.T) {
	ctx, pool := applyAll(t)
	fixture := seedPlanningFixture(t, ctx, pool)
	projectID, goalID := uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO projects (id, workspace_id, name, status) VALUES ($1, $2, 'Scoped', 'planned')`,
		projectID, fixture.workspaceID)
	exec(`INSERT INTO goals (id, workspace_id, title) VALUES ($1, $2, 'Outcome')`, goalID, fixture.workspaceID)

	_, err := pool.Exec(ctx,
		`INSERT INTO plans (workspace_id, project_id, goal_id, source, status) VALUES ($1, $2, $3, 'ai', 'draft')`,
		fixture.workspaceID, projectID, goalID)
	if code := sqlState(err); code != "23514" {
		t.Fatalf("ai plan with a project: err = %v (sqlstate %q), want 23514", err, code)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO plans (workspace_id, source, status) VALUES ($1, 'ai', 'draft')`, fixture.workspaceID)
	if code := sqlState(err); code != "23514" {
		t.Fatalf("ai plan without a goal: err = %v (sqlstate %q), want 23514", err, code)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO plans (workspace_id, goal_id, source, status) VALUES ($1, $2, 'ai', 'draft')`,
		fixture.workspaceID, goalID)
	if err != nil {
		t.Fatalf("goal-scoped ai plan: %v", err)
	}
	_, err = pool.Exec(ctx,
		`INSERT INTO plans (workspace_id, goal_id, source, status) VALUES ($1, $2, 'ai', 'draft')`,
		fixture.workspaceID, goalID)
	if code := sqlState(err); code != "23505" {
		t.Fatalf("second open plan for one goal: err = %v (sqlstate %q), want 23505", err, code)
	}
}

// 007 declared the category check without a name. 022 has to find and drop it
// by definition, then install the named, wider one.
func TestInboxCategoryCheckIsReplacedByTheNamedWiderOne(t *testing.T) {
	ctx, pool := applyAll(t)
	fixture := seedPlanningFixture(t, ctx, pool)

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM pg_constraint AS con
		   JOIN pg_class AS rel ON rel.oid = con.conrelid
		   JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
		  WHERE rel.relname = 'inbox_items' AND nsp.nspname = current_schema()
		    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%category%agentActivity%'`,
	).Scan(&count); err != nil {
		t.Fatalf("count category checks: %v", err)
	}
	if count != 1 {
		t.Fatalf("inbox_items carries %d category checks, want exactly the named one", count)
	}
	var name string
	if err := pool.QueryRow(ctx,
		`SELECT conname FROM pg_constraint AS con
		   JOIN pg_class AS rel ON rel.oid = con.conrelid
		   JOIN pg_namespace AS nsp ON nsp.oid = rel.relnamespace
		  WHERE rel.relname = 'inbox_items' AND nsp.nspname = current_schema()
		    AND con.contype = 'c' AND pg_get_constraintdef(con.oid) LIKE '%category%agentActivity%'`,
	).Scan(&name); err != nil || name != "inbox_items_category_ck" {
		t.Fatalf("category check name = %q (err %v), want inbox_items_category_ck", name, err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO inbox_items (workspace_id, recipient_id, event_type, category, title)
		 VALUES ($1, $2, 'approval.requested', 'approvals', 'Approve something')`,
		fixture.workspaceID, fixture.userID); err != nil {
		t.Fatalf("insert approvals category: %v", err)
	}
	_, err := pool.Exec(ctx,
		`INSERT INTO inbox_items (workspace_id, recipient_id, event_type, category, title)
		 VALUES ($1, $2, 'x', 'nonsense', 'Nope')`,
		fixture.workspaceID, fixture.userID)
	if code := sqlState(err); code != "23514" {
		t.Fatalf("unknown category: err = %v (sqlstate %q), want 23514", err, code)
	}
}
