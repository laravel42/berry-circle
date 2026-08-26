package plans_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	approvalhandlers "github.com/laravel42/berry-circle/server/internal/handlers/approvals"
	automationrunhandlers "github.com/laravel42/berry-circle/server/internal/handlers/automationruns"
	automationhandlers "github.com/laravel42/berry-circle/server/internal/handlers/automations"
	goalhandlers "github.com/laravel42/berry-circle/server/internal/handlers/goals"
	"github.com/laravel42/berry-circle/server/internal/handlers/issues"
	planhandlers "github.com/laravel42/berry-circle/server/internal/handlers/plans"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
	planrepo "github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// The P1a acceptance list, recorded against a real router and Postgres:
// goals and draft workflows persist and read back, the run ledger starts
// empty, approving a plan compiles it once, the issue-start gate holds
// against a raw write and answers APPROVAL_REQUIRED over HTTP, approving the
// gate releases the issue, goal progress counts, and the inbox shows the
// approval request in its own category.
func TestP1aPlanningContract(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)

	now := time.Date(2026, time.August, 25, 22, 0, 0, 0, time.UTC)
	ownerID, memberID, workspaceID, boardID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM outbox_events WHERE workspace_id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM inbox_projection_events WHERE workspace_id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
		for _, userID := range []uuid.UUID{ownerID, memberID} {
			_, _ = pool.Exec(context.Background(), `DELETE FROM idempotency_records WHERE actor_type = 'user' AND actor_id = $1`, userID)
			_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
		}
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %.40s: %v", sql, err)
		}
	}
	for _, user := range []struct {
		id   uuid.UUID
		name string
	}{{ownerID, "Contract Owner"}, {memberID, "Contract Member"}} {
		exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, $3, 'member', $4, $4)`,
			user.id, fmt.Sprintf("%s@berry.test", user.id), user.name, now)
	}
	exec(`INSERT INTO workspaces (id, name, slug, settings, created_by, created_at, updated_at) VALUES ($1, 'Planning', $2, '{"issuePrefix":"PLN"}'::jsonb, $3, $4, $4)`,
		workspaceID, "plan-"+workspaceID.String()[:8], ownerID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'owner', $4, $4), ($1, $3, 'member', $4, $4)`,
		workspaceID, ownerID, memberID, now)
	exec(`UPDATE users SET last_workspace_id = $1 WHERE id = ANY($2::uuid[])`, workspaceID, []uuid.UUID{ownerID, memberID})
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Planning', $3, $4, $5, $5)`,
		boardID, workspaceID, "b"+boardID.String()[:8], ownerID, now)

	sessions, err := coreauth.NewService(coreauth.ServiceOptions{Pool: pool, Now: func() time.Time { return now }, NewID: uuid.New, Random: rand.Reader, SessionTTL: 24 * time.Hour})
	if err != nil {
		t.Fatalf("auth service: %v", err)
	}
	authorization, err := identity.NewService(identity.ServiceOptions{Pool: pool, Now: func() time.Time { return now }, NewID: uuid.New, Random: rand.Reader})
	if err != nil {
		t.Fatalf("identity service: %v", err)
	}
	tokens := map[uuid.UUID]string{}
	for _, userID := range []uuid.UUID{ownerID, memberID} {
		token, err := coreauth.GenerateToken(rand.Reader)
		if err != nil {
			t.Fatalf("token: %v", err)
		}
		tokens[userID] = token
		exec(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)`,
			uuid.New(), userID, coreauth.HashToken(token), now.Add(time.Hour), now)
	}
	registry := integrationcore.NewRegistry()
	for _, provider := range append(providers.All(), providers.Berry{}) {
		registry.MustRegister(provider)
	}
	idempotency := httpapi.PostgresIdempotencyStore{Pool: pool}
	clock := func() time.Time { return now }
	var routes httpapi.Registry
	register := func(mounts []httpapi.Mount) {
		t.Helper()
		for _, mount := range mounts {
			if err := routes.Register(mount); err != nil {
				t.Fatalf("register %s: %v", mount.Prefix, err)
			}
		}
	}
	register(goalhandlers.Mounts(goalhandlers.Options{Pool: pool, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New, IdempotencyStore: idempotency}))
	register(approvalhandlers.Mounts(approvalhandlers.Options{Pool: pool, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New, IdempotencyStore: idempotency}))
	register(automationhandlers.Mounts(automationhandlers.Options{Pool: pool, Registry: registry, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New, IdempotencyStore: idempotency}))
	register(automationrunhandlers.Mounts(automationrunhandlers.Options{Pool: pool, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New}))
	register(planhandlers.Mounts(planhandlers.Options{Pool: pool, Registry: registry, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New, IdempotencyStore: idempotency}))
	register(issues.Mounts(issues.Options{Pool: pool, Sessions: sessions, Authorization: authorization, Clock: clock, NewID: uuid.New, IdempotencyStore: idempotency}))
	handler := routes.Handler(httpapi.Options{Logger: slog.New(slog.DiscardHandler), NewRequestID: func() string { return "req_p1a_contract_0001" }})

	call := func(userID uuid.UUID, method, path string, body any) (int, map[string]any) {
		t.Helper()
		var reader *bytes.Reader
		if body != nil {
			encoded, _ := json.Marshal(body)
			reader = bytes.NewReader(encoded)
		} else {
			reader = bytes.NewReader(nil)
		}
		request := httptest.NewRequest(method, path, reader)
		request.Header.Set("Authorization", "Bearer "+tokens[userID])
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		if method == http.MethodPost {
			request.Header.Set("Idempotency-Key", "p1a-"+uuid.NewString())
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var decoded map[string]any
		if response.Body.Len() > 0 {
			_ = json.Unmarshal(response.Body.Bytes(), &decoded)
		}
		t.Logf("%s %s -> %d %s", method, path, response.Code, truncate(response.Body.String(), 400))
		return response.Code, decoded
	}

	// 1. A goal persists and reads back with zero progress.
	status, goal := call(memberID, http.MethodPost, "/api/v1/goals", map[string]any{"workspaceId": workspaceID, "title": "Launch the donation site"})
	if status != http.StatusCreated {
		t.Fatalf("POST /goals = %d %v", status, goal)
	}
	goalID := goal["id"].(string)
	status, read := call(memberID, http.MethodGet, "/api/v1/goals/"+goalID, nil)
	if status != http.StatusOK || read["title"] != "Launch the donation site" || read["status"] != "draft" || read["progress"].(map[string]any)["issuesTotal"] != float64(0) {
		t.Fatalf("GET /goals/{id} = %d %v", status, read)
	}

	// 2. A draft workflow with a berry_event trigger and a create_issue step.
	definition := map[string]any{
		"version": "1",
		"trigger": map[string]any{"id": "on_done", "type": "berry_event", "event": "issue.completed"},
		"steps":   []any{map[string]any{"id": "follow_up", "type": "create_issue", "title": "Follow up {{ trigger.issue.identifier }}"}},
		"entry":   []string{"follow_up"},
	}
	status, workflow := call(memberID, http.MethodPost, "/api/v1/workflows", map[string]any{"workspaceId": workspaceID, "name": "Follow up done issues", "goalId": goalID, "definition": definition})
	if status != http.StatusCreated || workflow["status"] != "draft" {
		t.Fatalf("POST /workflows = %d %v", status, workflow)
	}
	workflowID := workflow["id"].(string)
	status, readWorkflow := call(memberID, http.MethodGet, "/api/v1/workflows/"+workflowID, nil)
	trigger := readWorkflow["trigger"].(map[string]any)
	if status != http.StatusOK || trigger["type"] != "berry_event" || trigger["event"] != "issue.completed" ||
		len(readWorkflow["validation"].(map[string]any)["errors"].([]any)) != 0 || readWorkflow["revision"] != float64(1) {
		t.Fatalf("GET /workflows/{id} = %d %v", status, readWorkflow)
	}
	stored := readWorkflow["definition"].(map[string]any)
	if stored["entry"].([]any)[0] != "follow_up" || len(stored["steps"].([]any)) != 1 {
		t.Fatalf("definition did not round-trip: %v", stored)
	}

	// 3. The run ledger is empty.
	status, runs := call(memberID, http.MethodGet, "/api/v1/workflow-runs?workspaceId="+workspaceID.String(), nil)
	if status != http.StatusOK || len(runs["nodes"].([]any)) != 0 || runs["pageInfo"].(map[string]any)["hasNextPage"] != false {
		t.Fatalf("GET /workflow-runs = %d %v", status, runs)
	}

	// 4. A hand-inserted valid IR on the goal compiles on approve, once.
	planStore, _ := planrepo.New(pool)
	parsedGoal := uuid.MustParse(goalID)
	header, _, err := planStore.CreateGenerated(ctx, planrepo.CreateGeneratedParams{
		ID: uuid.New(), WorkspaceID: workspaceID, GoalID: &parsedGoal, BoardID: &boardID, Prompt: "Launch the donation site", ActorID: memberID, CreatedAt: now,
	})
	if err != nil {
		t.Fatalf("CreateGenerated: %v", err)
	}
	ir := `{
	  "$schema": "berry-plan/1", "version": "1",
	  "goal": {"tempId": "g_site", "title": "Launch the donation site"},
	  "issues": [
	    {"tempId": "i_design", "title": "Design the page", "type": "issue", "requiredCapabilities": ["design"]},
	    {"tempId": "i_build", "title": "Build the page", "type": "issue", "dependsOn": ["i_design"]},
	    {"tempId": "i_release", "title": "Release the page", "type": "issue", "requiresApproval": true}
	  ],
	  "workflows": [{"tempId": "w_thanks", "name": "Thank donors",
	    "trigger": {"id": "on_done", "type": "berry_event", "event": "issue.completed"},
	    "steps": [{"id": "notify", "type": "create_issue", "title": "Thank {{ trigger.issue.identifier }}"}],
	    "entry": ["notify"]}],
	  "confidence": 0.8
	}`
	if _, err := planStore.SaveVersion(ctx, planrepo.SaveVersionParams{PlanID: header.ID, ExpectedVersion: 0, Origin: planrepo.OriginGenerated, IR: json.RawMessage(ir), ValidationStatus: planrepo.ValidationValid, CreatedAt: now}); err != nil {
		t.Fatalf("SaveVersion: %v", err)
	}
	// A hand-inserted IR stands in for a finished generation; a plan still
	// generating answers PLAN_BUSY on approve.
	if err := planStore.FinishGeneration(ctx, planrepo.FinishGenerationParams{PlanID: header.ID, Status: planrepo.GenerationSucceeded, ValidationStatus: planrepo.ValidationValid, Now: now}); err != nil {
		t.Fatalf("FinishGeneration: %v", err)
	}
	planPath := "/api/v1/plans/" + header.ID.String()
	status, plan := call(memberID, http.MethodPost, planPath+"/approve", map[string]any{})
	compile := plan["compile"].(map[string]any)
	if status != http.StatusOK || plan["status"] != "approved" || compile["status"] != "succeeded" || len(compile["issueIds"].([]any)) != 3 || len(compile["workflowIds"].([]any)) != 1 {
		t.Fatalf("POST /plans/{id}/approve = %d %v", status, plan)
	}
	countIssues := func() int {
		var n int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE board_id = $1`, boardID).Scan(&n); err != nil {
			t.Fatalf("count issues: %v", err)
		}
		return n
	}
	if countIssues() != 3 {
		t.Fatalf("issues after compile = %d, want 3", countIssues())
	}
	status, again := call(memberID, http.MethodPost, planPath+"/approve", map[string]any{})
	if status != http.StatusOK || again["compile"].(map[string]any)["status"] != "succeeded" || countIssues() != 3 {
		t.Fatalf("second approve = %d %v, issues = %d; want a no-op", status, again, countIssues())
	}
	statuses := map[string]string{}
	var gatedID uuid.UUID
	rows, err := pool.Query(ctx, `SELECT id, title, status::text FROM issues WHERE board_id = $1`, boardID)
	if err != nil {
		t.Fatalf("issues: %v", err)
	}
	for rows.Next() {
		var (
			id            uuid.UUID
			title, status string
		)
		_ = rows.Scan(&id, &title, &status)
		statuses[title] = status
		if title == "Release the page" {
			gatedID = id
		}
	}
	rows.Close()
	if statuses["Design the page"] != "todo" || statuses["Build the page"] != "blocked" || statuses["Release the page"] != "backlog" {
		t.Fatalf("compiled statuses = %v", statuses)
	}

	// 5. The gate holds against a raw write and answers over HTTP.
	_, err = pool.Exec(ctx, `UPDATE issues SET status = 'todo' WHERE id = $1`, gatedID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23001" {
		t.Fatalf("raw UPDATE to todo = %v, want restrict_violation", err)
	}
	status, refused := call(memberID, http.MethodPatch, "/api/v1/issues/"+gatedID.String(), map[string]any{"status": "todo"})
	if status != http.StatusConflict || refused["error"].(map[string]any)["code"] != "APPROVAL_REQUIRED" {
		t.Fatalf("PATCH gated issue = %d %v", status, refused)
	}
	approvalID, _ := refused["error"].(map[string]any)["details"].(map[string]any)["approvalId"].(string)
	if approvalID == "" {
		t.Fatalf("APPROVAL_REQUIRED carries no approvalId: %v", refused)
	}

	// 6. Progress counts the plan's issues, the pending gate, and no active workflow yet.
	_, progressBefore := call(memberID, http.MethodGet, "/api/v1/goals/"+goalID, nil)
	before := progressBefore["progress"].(map[string]any)
	if before["issuesTotal"] != float64(3) || before["approvalsPending"] != float64(1) || before["workflowsActive"] != float64(0) || progressBefore["status"] != "planned" {
		t.Fatalf("goal progress before approval = %v (status %v)", before, progressBefore["status"])
	}

	// 7. The inbox shows the request to the owner (the addressed admin role).
	p2Store, _ := p2repo.New(pool)
	if _, err := p2Store.ProjectInboxBatch(ctx, uuid.New, func() time.Time { return now.Add(time.Minute) }, 100); err != nil {
		t.Fatalf("ProjectInboxBatch: %v", err)
	}
	items, err := p2Store.ListInbox(ctx, workspaceID, ownerID, p2repo.InboxFilter{State: "all", Limit: 50})
	if err != nil {
		t.Fatalf("ListInbox: %v", err)
	}
	foundApproval := false
	for _, item := range items {
		if item.EventType == "approval.requested" && item.Category == "approvals" && item.ApprovalID != nil && item.ApprovalID.String() == approvalID {
			foundApproval = true
		}
	}
	if !foundApproval {
		t.Fatalf("inbox has no approval.requested item in category approvals: %+v", items)
	}

	// 8. Approving the gate releases the issue to todo.
	status, resolved := call(ownerID, http.MethodPost, "/api/v1/approvals/"+approvalID+"/approve", map[string]any{"note": "ship it"})
	if status != http.StatusOK || resolved["status"] != "approved" {
		t.Fatalf("POST /approvals/{id}/approve = %d %v", status, resolved)
	}
	status, released := call(memberID, http.MethodGet, "/api/v1/issues/"+gatedID.String(), nil)
	if status != http.StatusOK || released["status"] != "todo" || released["goal"].(map[string]any)["id"] != goalID {
		t.Fatalf("released issue = %d %v", status, released)
	}
	// A member may not resolve a gate addressed to admins; the owner asking
	// again learns it is already resolved.
	if status, _ := call(memberID, http.MethodPost, "/api/v1/approvals/"+approvalID+"/approve", map[string]any{}); status != http.StatusForbidden {
		t.Fatalf("member resolving an admin gate = %d, want 403", status)
	}
	if status, body := call(ownerID, http.MethodPost, "/api/v1/approvals/"+approvalID+"/approve", map[string]any{}); status != http.StatusConflict ||
		body["error"].(map[string]any)["code"] != "APPROVAL_RESOLVED" {
		t.Fatalf("re-approving a resolved gate = %d %v, want 409 APPROVAL_RESOLVED", status, body)
	}

	// 9. Activating the manual workflow counts on the goal.
	status, activated := call(ownerID, http.MethodPost, "/api/v1/workflows/"+workflowID+"/activate", map[string]any{})
	if status != http.StatusOK || activated["status"] != "active" {
		t.Fatalf("POST /workflows/{id}/activate = %d %v", status, activated)
	}
	_, progressAfter := call(memberID, http.MethodGet, "/api/v1/goals/"+goalID, nil)
	after := progressAfter["progress"].(map[string]any)
	if after["approvalsPending"] != float64(0) || after["workflowsActive"] != float64(1) || after["issuesTotal"] != float64(3) {
		t.Fatalf("goal progress after approval = %v", after)
	}
	if status, list := call(memberID, http.MethodGet, "/api/v1/goals/"+goalID+"/workflows", nil); status != http.StatusOK || len(list["nodes"].([]any)) != 2 {
		t.Fatalf("GET /goals/{id}/workflows = %d %v", status, list)
	}
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "…"
}
