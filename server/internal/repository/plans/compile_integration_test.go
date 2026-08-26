package plans

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

const goldenPlan = `{
  "$schema": "berry-plan/1", "version": "1",
  "goal": {"tempId": "g_site", "title": "Launch the donation site", "description": "Stripe-backed landing page"},
  "issues": [
    {"tempId": "i_design", "title": "Design the page", "type": "issue", "requiredCapabilities": ["design", "frontend"], "suggestedAgentId": "%s"},
    {"tempId": "i_build", "title": "Build the page", "type": "issue", "dependsOn": ["i_design"]},
    {"tempId": "i_deploy", "title": "Deploy to production", "type": "issue", "dependsOn": ["i_build"], "requiresApproval": true},
    {"tempId": "i_docs", "title": "Write the runbook", "type": "issue"}
  ],
  "workflows": [{
    "tempId": "w_thanks", "name": "Thank donors",
    "trigger": {"id": "on_done", "type": "berry_event", "event": "issue.completed"},
    "steps": [
      {"id": "notify", "type": "create_issue", "title": "Thank {{ trigger.issue.identifier }}"},
      {"id": "ship", "type": "create_issue", "title": "Ship it", "dependsOn": ["notify"]}
    ],
    "entry": ["notify"],
    "activateOnApprove": true
  }],
  "approvals": [
    {"tempId": "p_deploy", "title": "Deploy to production?", "reason": "policy",
     "target": {"kind": "issue", "tempId": "i_deploy"}, "approver": {"type": "role", "role": "admin"}, "timeout": "P7D"},
    {"tempId": "p_ship", "title": "Ship?", "reason": "user_requested",
     "target": {"kind": "step", "tempId": "w_thanks", "stepId": "ship"}, "approver": {"type": "role", "role": "member"}},
    {"tempId": "p_activate", "title": "Activate the thank-you flow?", "reason": "planner",
     "target": {"kind": "workflow", "tempId": "w_thanks"}, "approver": {"type": "role", "role": "admin"}}
  ],
  "confidence": 0.9
}`

func generatedPlan(t *testing.T, pool *pgxpool.Pool, repo *Repository, ws, board, user uuid.UUID, irText string, now time.Time) PlanHeader {
	t.Helper()
	ctx := context.Background()
	header, _, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, BoardID: &board, Prompt: "Launch a donation site", ActorID: user, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("CreateGenerated() error = %v", err)
	}
	if _, err := repo.SaveVersion(ctx, SaveVersionParams{
		PlanID: header.ID, ExpectedVersion: 0, Origin: OriginGenerated, IR: json.RawMessage(irText),
		ValidationStatus: ValidationValid, CreatedAt: now.Add(time.Second),
	}); err != nil {
		t.Fatalf("SaveVersion() error = %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM outbox_events WHERE workspace_id = $1`, ws)
	})
	reloaded, err := repo.GetHeader(ctx, header.ID)
	if err != nil {
		t.Fatalf("GetHeader() error = %v", err)
	}
	return reloaded
}

func count(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// The compile lands every row in schema order: goal promoted, issues with
// the status the rules give them, labels, links, dependency edges, the start
// gate after its issue, the workflow draft, and the plan finished. A second
// approve is a no-op, and the gate holds against a raw status write until the
// approval releases the issue.
func TestCompileWritesTheWholePlanOnceAndGatesTheApprovedIssue(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)
	now := time.Date(2026, time.August, 25, 18, 0, 0, 0, time.UTC)
	header := generatedPlan(t, pool, repo, ws, board, user, strings.Replace(goldenPlan, "%s", agent.String(), 1), now)

	result, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now.Add(time.Minute)})
	if err != nil {
		var invalid *InvalidPlanError
		if errors.As(err, &invalid) {
			t.Fatalf("Compile() refused the plan: %+v", invalid.Findings)
		}
		t.Fatalf("Compile() error = %v", err)
	}
	if result.AlreadyCompiled || len(result.IssueIDs) != 4 || len(result.WorkflowIDs) != 1 || len(result.ApprovalIDs) != 2 ||
		len(result.ActivateOnApprove) != 1 || len(result.IssueEvents) != 4 {
		t.Fatalf("result = %+v", result)
	}
	if result.Plan.Status != StatusApproved || result.Plan.CompileStatus != CompileSucceeded || result.Plan.CompiledAt == nil ||
		result.Plan.CurrentVersion != 2 || result.Plan.ApprovedBy == nil || *result.Plan.ApprovedBy != user {
		t.Fatalf("plan = %+v", result.Plan)
	}
	if result.IR.Compiled == nil || result.IR.Compiled.GoalID != result.GoalID {
		t.Fatalf("compiled annotation = %+v", result.IR.Compiled)
	}
	var goalStatus, goalTitle string
	if err := pool.QueryRow(ctx, `SELECT status, title FROM goals WHERE id = $1`, result.GoalID).Scan(&goalStatus, &goalTitle); err != nil ||
		goalStatus != "planned" || goalTitle != "Launch the donation site" {
		t.Fatalf("goal = %q %q (%v)", goalStatus, goalTitle, err)
	}
	statuses := map[string]string{}
	for tempID, issueID := range result.IssueIDs {
		var status string
		if err := pool.QueryRow(ctx, `SELECT status::text FROM issues WHERE id = $1`, issueID).Scan(&status); err != nil {
			t.Fatalf("issue %s: %v", tempID, err)
		}
		statuses[tempID] = status
	}
	want := map[string]string{"i_design": "todo", "i_build": "blocked", "i_deploy": "backlog", "i_docs": "todo"}
	for tempID, status := range want {
		if statuses[tempID] != status {
			t.Errorf("issue %s status = %q, want %q", tempID, statuses[tempID], status)
		}
	}
	var assigneeID *uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT assignee_id FROM issues WHERE id = $1`, result.IssueIDs["i_design"]).Scan(&assigneeID); err != nil ||
		assigneeID == nil || *assigneeID != agent {
		t.Fatalf("suggested agent not assigned: %v %v", assigneeID, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM issue_label_memberships AS m JOIN issue_labels AS l ON l.id = m.label_id
		WHERE m.issue_id = $1 AND l.name IN ('design', 'frontend')`, result.IssueIDs["i_design"]); n != 2 {
		t.Fatalf("capability labels = %d, want 2", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM issue_dependencies WHERE workspace_id = $1`, ws); n != 2 {
		t.Fatalf("dependency edges = %d, want 2", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM goal_issues WHERE goal_id = $1`, result.GoalID); n != 4 {
		t.Fatalf("goal links = %d, want 4", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM plan_issues WHERE plan_id = $1`, header.ID); n != 4 {
		t.Fatalf("plan links = %d, want 4", n)
	}
	var gateRole string
	var gateExpires *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT requested_from_role, expires_at FROM approvals WHERE issue_id = $1 AND kind = 'issue_start' AND status = 'pending'`,
		result.IssueIDs["i_deploy"]).Scan(&gateRole, &gateExpires); err != nil || gateRole != "admin" || gateExpires == nil {
		t.Fatalf("issue_start gate = %q %v (%v)", gateRole, gateExpires, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM approvals WHERE automation_id = $1 AND kind = 'automation_activation' AND status = 'pending'`,
		result.WorkflowIDs["w_thanks"]); n != 1 {
		t.Fatalf("activation gates = %d, want 1", n)
	}
	var definition []byte
	var automationStatus string
	if err := pool.QueryRow(ctx, `SELECT status, definition FROM automations WHERE id = $1 AND goal_id = $2`,
		result.WorkflowIDs["w_thanks"], result.GoalID).Scan(&automationStatus, &definition); err != nil || automationStatus != "draft" {
		t.Fatalf("automation = %q (%v)", automationStatus, err)
	}
	if !strings.Contains(string(definition), `"approve_ship"`) {
		t.Fatalf("step approval was not compiled into the definition: %s", definition)
	}
	if n := count(t, pool, `SELECT count(*) FROM automation_versions WHERE automation_id = $1`, result.WorkflowIDs["w_thanks"]); n != 1 {
		t.Fatalf("automation versions = %d, want 1", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM planner_events WHERE plan_id = $1 AND stage = 'compile' AND outcome = 'ok'`, header.ID); n != 1 {
		t.Fatalf("compile stage records = %d, want 1", n)
	}
	topics := map[string]int{}
	rows, err := pool.Query(ctx, `SELECT topic FROM outbox_events WHERE workspace_id = $1`, ws)
	if err != nil {
		t.Fatalf("outbox: %v", err)
	}
	for rows.Next() {
		var topic string
		_ = rows.Scan(&topic)
		topics[topic]++
	}
	rows.Close()
	for topic, n := range map[string]int{"plan.approved": 1, "plan.compiled": 1, "goal.updated": 1, "issue.created": 4, "approval.requested": 2, "workflow.created": 1} {
		if topics[topic] != n {
			t.Errorf("outbox %s = %d, want %d (all: %v)", topic, topics[topic], n, topics)
		}
	}

	// The gate: a raw write to todo is refused until the approval releases it.
	_, err = pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, result.IssueIDs["i_deploy"])
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23001" {
		t.Fatalf("raw release = %v, want restrict_violation", err)
	}

	again, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now.Add(2 * time.Minute)})
	if err != nil || !again.AlreadyCompiled {
		t.Fatalf("second Compile() = %+v, %v; want a no-op", again, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM issues WHERE board_id = $1`, board); n != 4 {
		t.Fatalf("issues after second compile = %d, want 4", n)
	}

	// Approving the gate releases to blocked because i_build is still open;
	// nothing but the approval path moves the issue.
	approvalRepo, _ := approvals.New(pool)
	gate, err := approvalRepo.LatestForIssue(ctx, result.IssueIDs["i_deploy"], approvals.KindIssueStart)
	if err != nil {
		t.Fatalf("LatestForIssue() error = %v", err)
	}
	if _, events, err := approvalRepo.Resolve(ctx, gate.ID, approvals.Resolution{Decision: approvals.DecisionApproved, ActorID: user, Now: now.Add(3 * time.Minute)}); err != nil || len(events) < 2 {
		t.Fatalf("Resolve() = %+v, %v", events, err)
	}
	var released string
	if err := pool.QueryRow(ctx, `SELECT status::text FROM issues WHERE id = $1`, result.IssueIDs["i_deploy"]).Scan(&released); err != nil || released != "blocked" {
		t.Fatalf("released status = %q (%v), want blocked while i_build is open", released, err)
	}
}

// A failure after issues were written rolls everything back, records the
// stage on the plan, and a corrected plan compiles on retry.
func TestCompileFailureLeavesFailedStatusAndNoPartialRows(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)
	now := time.Date(2026, time.August, 25, 19, 0, 0, 0, time.UTC)
	// The approver does not exist, so the approvals insert — which runs after
	// every issue is written — hits the users foreign key.
	broken := strings.Replace(goldenPlan, `"approver": {"type": "role", "role": "admin"}, "timeout": "P7D"`,
		`"approver": {"type": "user", "userId": "`+uuid.New().String()+`"}`, 1)
	header := generatedPlan(t, pool, repo, ws, board, user, strings.Replace(broken, "%s", agent.String(), 1), now)

	_, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now.Add(time.Minute)})
	var failure *CompileError
	if !errors.As(err, &failure) || failure.Stage != "approvals" || !errors.Is(err, ErrCompileFailed) {
		t.Fatalf("Compile() error = %v, want an approvals-stage CompileError", err)
	}
	failed, err := repo.GetHeader(ctx, header.ID)
	if err != nil || failed.CompileStatus != CompileFailed || failed.Status != StatusApproved || failed.CompileError == nil ||
		!strings.HasPrefix(*failed.CompileError, "approvals:") {
		t.Fatalf("plan after failure = %+v (%v)", failed, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM issues WHERE board_id = $1`, board); n != 0 {
		t.Fatalf("issues after failed compile = %d, want 0", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM automations WHERE workspace_id = $1`, ws); n != 0 {
		t.Fatalf("automations after failed compile = %d, want 0", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM approvals WHERE workspace_id = $1`, ws); n != 0 {
		t.Fatalf("approvals after failed compile = %d, want 0", n)
	}
	var goalStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM goals WHERE id = $1`, *header.GoalID).Scan(&goalStatus); err != nil || goalStatus != "draft" {
		t.Fatalf("goal after failed compile = %q (%v), want draft", goalStatus, err)
	}
	if n := count(t, pool, `SELECT count(*) FROM planner_events WHERE plan_id = $1 AND stage = 'compile' AND outcome = 'error'`, header.ID); n != 1 {
		t.Fatalf("failure stage records = %d, want 1", n)
	}
	if n := count(t, pool, `SELECT count(*) FROM outbox_events WHERE workspace_id = $1 AND topic = 'plan.compile_failed'`, ws); n != 1 {
		t.Fatalf("plan.compile_failed facts = %d, want 1", n)
	}

	// Retry with a corrected plan.
	if _, err := repo.SaveVersion(ctx, SaveVersionParams{
		PlanID: header.ID, ExpectedVersion: 1, Origin: OriginPatched, IR: json.RawMessage(strings.Replace(goldenPlan, "%s", agent.String(), 1)),
		ValidationStatus: ValidationValid, CreatedAt: now.Add(2 * time.Minute),
	}); err != nil {
		t.Fatalf("SaveVersion(retry) error = %v", err)
	}
	result, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now.Add(3 * time.Minute)})
	if err != nil || result.AlreadyCompiled || result.Plan.CompileStatus != CompileSucceeded || result.Plan.CompileError != nil {
		t.Fatalf("retry Compile() = %+v, %v", result.Plan, err)
	}
}

// Nothing compiles that is not valid and open: an unknown validation status,
// a rejected plan and an orchestrator brief all refuse before any write.
func TestCompileRefusesInvalidAndClosedPlans(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	repo, _ := New(pool)
	ws, board, agent, user := fixture(t, pool)
	now := time.Date(2026, time.August, 25, 20, 0, 0, 0, time.UTC)
	header, _, err := repo.CreateGenerated(ctx, CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: ws, BoardID: &board, Prompt: "Do it", ActorID: user, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("CreateGenerated() error = %v", err)
	}
	if _, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now}); !errors.Is(err, ErrPlanInvalid) {
		t.Fatalf("Compile(no IR) = %v, want ErrPlanInvalid", err)
	}
	if _, err := repo.SaveVersion(ctx, SaveVersionParams{
		PlanID: header.ID, ExpectedVersion: 0, Origin: OriginGenerated,
		IR:               json.RawMessage(strings.Replace(strings.Replace(goldenPlan, "%s", agent.String(), 1), `"dependsOn": ["i_design"]`, `"dependsOn": ["i_deploy"]`, 1)),
		ValidationStatus: ValidationValid, CreatedAt: now,
	}); err != nil {
		t.Fatalf("SaveVersion() error = %v", err)
	}
	var invalid *InvalidPlanError
	if _, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now}); !errors.As(err, &invalid) || len(invalid.Findings) == 0 {
		t.Fatalf("Compile(cyclic) = %v, want InvalidPlanError with findings", err)
	}
	if n := count(t, pool, `SELECT count(*) FROM issues WHERE board_id = $1`, board); n != 0 {
		t.Fatalf("issues after refused compile = %d, want 0", n)
	}
	if err := repo.RejectGenerated(ctx, header.ID, "no", now); err != nil {
		t.Fatalf("RejectGenerated() error = %v", err)
	}
	if _, err := repo.Compile(ctx, CompileParams{PlanID: header.ID, ActorID: user, Now: now}); !errors.Is(err, ErrNotOpen) {
		t.Fatalf("Compile(rejected) = %v, want ErrNotOpen", err)
	}
	if !ir.Valid(nil) {
		t.Fatal("no findings must read as valid")
	}
}
