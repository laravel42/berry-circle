package plans_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	planhandlers "github.com/laravel42/berry-circle/server/internal/handlers/plans"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/planner"
	"github.com/laravel42/berry-circle/server/internal/planner/prompts"
	planrepo "github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// roleChat is a fake OpenFang chat route keyed by role agent name.
type roleChat struct {
	mu      sync.Mutex
	replies map[string][]string
	gates   map[string]chan struct{}
	calls   map[string]int
	server  *httptest.Server
}

func (chat *roleChat) handle(response http.ResponseWriter, request *http.Request) {
	var body struct {
		Model string `json:"model"`
	}
	_ = json.NewDecoder(request.Body).Decode(&body)
	chat.mu.Lock()
	chat.calls[body.Model]++
	gate := chat.gates[body.Model]
	var reply string
	if list := chat.replies[body.Model]; len(list) > 0 {
		reply = list[0]
		chat.replies[body.Model] = list[1:]
	}
	chat.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-request.Context().Done():
			return
		}
	}
	if reply == "" {
		response.WriteHeader(http.StatusInternalServerError)
		return
	}
	encoded, _ := json.Marshal(reply)
	response.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(response, `{"object":"chat.completion","choices":[{"message":{"role":"assistant","content":`+string(encoded)+`}}],"usage":{"prompt_tokens":90,"completion_tokens":40}}`)
}

// The P5 acceptance list over a real router and Postgres: a viewer is
// refused with PLAN_FORBIDDEN, POST /generate answers 202 and the plan reads
// with the stage in progress while the pipeline runs, the finished plan is
// valid with agents assigned by skill and its planner_events carry usage but
// no prompt, plan.updated facts reach the outbox, an invalid plan whose
// repairs ran out cannot be approved or compiled (409 PLAN_INVALID), and
// GET /roles is for admins.
func TestP5aGenerateContract(t *testing.T) {
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

	fixtureRaw, err := os.ReadFile(filepath.Join("..", "..", "planner", "testdata", "planner", "simple-issue.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fixture struct {
		UserPrompt   string `json:"userPrompt"`
		ModelReplies struct {
			Intent  string   `json:"intent"`
			Planner []string `json:"planner"`
			Critic  []string `json:"critic"`
		} `json:"modelReplies"`
	}
	if err := json.Unmarshal(fixtureRaw, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	// model_role_agents is global (one row per role); every suite that
	// rewrites it holds the same advisory lock so packages running in
	// parallel never see each other's rows.
	lockConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire lock connection: %v", err)
	}
	if _, err := lockConn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('berry-test:model_role_agents'))`); err != nil {
		t.Fatalf("advisory lock: %v", err)
	}
	t.Cleanup(func() {
		_, _ = lockConn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('berry-test:model_role_agents'))`)
		lockConn.Release()
	})

	now := time.Date(2026, time.August, 25, 23, 0, 0, 0, time.UTC)
	adminID, memberID, viewerID, workspaceID, boardID, agentID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	fixtureAgentID := "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0"
	suffix := uuid.NewString()[:8]
	roleStore, err := modelgateway.NewStore(pool)
	if err != nil {
		t.Fatalf("role store: %v", err)
	}
	previousRoles, _ := roleStore.List(ctx)
	// sweep removes one of this test's workspaces and everything under it,
	// in the order the foreign keys allow: issues before the agent they are
	// assigned to, the agent before its workspace (RESTRICT), plans and goals
	// with the workspace. Failures are reported, not swallowed, so residue is
	// visible the run it happens.
	sweep := func(workspaceID uuid.UUID) {
		background := context.Background()
		for _, statement := range []string{
			`DELETE FROM outbox_events WHERE workspace_id = $1`,
			`DELETE FROM inbox_projection_events WHERE workspace_id = $1`,
			`DELETE FROM plans WHERE workspace_id = $1`,
			`DELETE FROM approvals WHERE workspace_id = $1`,
			`DELETE FROM automations WHERE workspace_id = $1`,
			`DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = $1)`,
			`DELETE FROM goals WHERE workspace_id = $1`,
			`DELETE FROM boards WHERE workspace_id = $1`,
			`DELETE FROM agents WHERE workspace_id = $1 AND NOT protected`,
		} {
			if _, err := pool.Exec(background, statement, workspaceID); err != nil {
				t.Logf("cleanup %.50s: %v", statement, err)
			}
		}
		// Every workspace owns a protected orchestrator agent that cannot be
		// deleted and restricts the workspace delete, so the shell is soft
		// deleted the way the product does it.
		if _, err := pool.Exec(background, `DELETE FROM workspaces WHERE id = $1`, workspaceID); err != nil {
			if _, err := pool.Exec(background, `UPDATE workspaces SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, workspaceID); err != nil {
				t.Logf("cleanup soft-delete workspace %s: %v", workspaceID, err)
			}
		}
	}
	// Residue of an interrupted earlier run of this test: its workspaces carry
	// the p5a- slug prefix and nothing else does.
	if rows, err := pool.Query(ctx, `SELECT id FROM workspaces WHERE slug LIKE 'p5a-%' AND deleted_at IS NULL`); err == nil {
		var stale []uuid.UUID
		for rows.Next() {
			var id uuid.UUID
			if rows.Scan(&id) == nil {
				stale = append(stale, id)
			}
		}
		rows.Close()
		for _, id := range stale {
			sweep(id)
		}
	}
	t.Cleanup(func() {
		sweep(workspaceID)
		for _, userID := range []uuid.UUID{adminID, memberID, viewerID} {
			_, _ = pool.Exec(context.Background(), `DELETE FROM idempotency_records WHERE actor_type = 'user' AND actor_id = $1`, userID)
			_, _ = pool.Exec(context.Background(), `DELETE FROM sessions WHERE user_id = $1`, userID)
			if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID); err != nil {
				t.Logf("cleanup user %s: %v", userID, err)
			}
		}
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_role_agents`)
		for _, row := range previousRoles {
			_ = roleStore.Upsert(context.Background(), row, time.Now())
		}
	})
	// The fixture names its agent by a fixed id; this run's agent gets a
	// fresh one so a residue row from an interrupted run cannot collide.
	fixture.ModelReplies.Planner[0] = strings.ReplaceAll(fixture.ModelReplies.Planner[0], fixtureAgentID, agentID.String())
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed %.40s: %v", sql, err)
		}
	}
	for _, user := range []struct {
		id   uuid.UUID
		name string
	}{{adminID, "P5 Admin"}, {memberID, "P5 Member"}, {viewerID, "P5 Viewer"}} {
		exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, $3, 'member', $4, $4)`,
			user.id, fmt.Sprintf("%s@berry.test", user.id), user.name, now)
	}
	exec(`INSERT INTO workspaces (id, name, slug, settings, created_by, created_at, updated_at) VALUES ($1, 'Planner', $2, '{"issuePrefix":"PLN"}'::jsonb, $3, $4, $4)`,
		workspaceID, "p5a-"+workspaceID.String()[:8], adminID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $5, $5), ($1, $3, 'member', $5, $5), ($1, $4, 'viewer', $5, $5)`,
		workspaceID, adminID, memberID, viewerID, now)
	exec(`UPDATE users SET last_workspace_id = $1 WHERE id = ANY($2::uuid[])`, workspaceID, []uuid.UUID{adminID, memberID, viewerID})
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Planner', $3, $4, $5, $5)`,
		boardID, workspaceID, "b"+boardID.String()[:8], adminID, now)
	exec(`INSERT INTO agents (id, workspace_id, openfang_agent_id, name, status, skills, created_at, updated_at) VALUES ($1, $2, gen_random_uuid(), 'Coder', 'available', ARRAY['frontend','debugging'], $3, $3)`,
		agentID, workspaceID, now)

	chat := &roleChat{replies: map[string][]string{}, gates: map[string]chan struct{}{}, calls: map[string]int{}}
	chat.server = httptest.NewServer(http.HandlerFunc(chat.handle))
	t.Cleanup(chat.server.Close)
	if _, err := pool.Exec(ctx, `DELETE FROM model_role_agents`); err != nil {
		t.Fatalf("clear roles: %v", err)
	}
	roleNames := map[modelgateway.Role]string{}
	for _, role := range modelgateway.Roles {
		name := fmt.Sprintf("berry-%s-%s", role, suffix)
		roleNames[role] = name
		prompt, _ := prompts.ForRole(string(role))
		if err := roleStore.Upsert(ctx, modelgateway.RoleAgent{
			Role: role, OpenFangAgentID: uuid.New(), UpstreamName: name, Provider: "openrouter", Model: "test/model",
			PromptVersion: prompt.Version, Status: modelgateway.StatusAvailable,
		}, now); err != nil {
			t.Fatalf("upsert role %s: %v", role, err)
		}
	}
	client, err := openfang.New(chat.server.URL, "", chat.server.Client(), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("openfang client: %v", err)
	}
	gateway, err := modelgateway.NewOpenFang(client, roleStore, nil)
	if err != nil {
		t.Fatalf("gateway: %v", err)
	}

	sessions, err := coreauth.NewService(coreauth.ServiceOptions{Pool: pool, Now: func() time.Time { return now }, NewID: uuid.New, Random: rand.Reader, SessionTTL: 24 * time.Hour})
	if err != nil {
		t.Fatalf("auth service: %v", err)
	}
	authorization, err := identity.NewService(identity.ServiceOptions{Pool: pool, Now: func() time.Time { return now }, NewID: uuid.New, Random: rand.Reader})
	if err != nil {
		t.Fatalf("identity service: %v", err)
	}
	tokens := map[uuid.UUID]string{}
	for _, userID := range []uuid.UUID{adminID, memberID, viewerID} {
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
	planStore, err := planrepo.New(pool)
	if err != nil {
		t.Fatalf("plan store: %v", err)
	}
	workerCtx, cancelWorkers := context.WithCancel(ctx)
	t.Cleanup(cancelWorkers)
	sources := planner.PostgresSources{Pool: pool}
	service, err := planner.New(planner.Options{
		Gateway: gateway, Store: planStore,
		Sources:       planner.Sources{Workspace: sources, Agents: sources, Issues: sources, Workflows: sources, Goals: sources, Project: sources, Registry: registry},
		Authorization: authorization, Clock: time.Now, NewID: uuid.New, WorkerContext: workerCtx, PlannerVersion: prompts.Planner().Version,
		MaxRepairs: 1, MaxCriticRounds: 1, Timeout: 30 * time.Second, ContextBudgetBytes: 48 * 1024, Logger: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("planner: %v", err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = service.Close(closeCtx)
	})
	idempotency := httpapi.PostgresIdempotencyStore{Pool: pool}
	var routes httpapi.Registry
	for _, mount := range planhandlers.Mounts(planhandlers.Options{
		Pool: pool, Registry: registry, Sessions: sessions, Authorization: authorization, Clock: time.Now, NewID: uuid.New, IdempotencyStore: idempotency,
		Planner: service, Validator: service, Roles: roleStore,
	}) {
		if err := routes.Register(mount); err != nil {
			t.Fatalf("register %s: %v", mount.Prefix, err)
		}
	}
	handler := routes.Handler(httpapi.Options{Logger: slog.New(slog.DiscardHandler), NewRequestID: func() string { return "req_p5a_contract_0001" }})
	calls := 0
	call := func(userID uuid.UUID, method, path string, body any) (int, map[string]any, http.Header) {
		t.Helper()
		calls++
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
			request.Header.Set("Idempotency-Key", fmt.Sprintf("p5a-%s-%04d", suffix, calls))
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		var decoded map[string]any
		if recorder.Body.Len() > 0 {
			_ = json.Unmarshal(recorder.Body.Bytes(), &decoded)
		}
		return recorder.Code, decoded, recorder.Header()
	}
	nested := func(object map[string]any, path ...string) any {
		var current any = object
		for _, key := range path {
			next, ok := current.(map[string]any)
			if !ok {
				return nil
			}
			current = next[key]
		}
		return current
	}
	waitFor := func(planID string, done func(map[string]any) bool) map[string]any {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			code, body, _ := call(adminID, http.MethodGet, "/api/v1/plans/"+planID, nil)
			if code != http.StatusOK {
				t.Fatalf("GET plan = %d %v", code, body)
			}
			if done(body) {
				return body
			}
			time.Sleep(25 * time.Millisecond)
		}
		t.Fatalf("plan %s did not reach the expected state", planID)
		return nil
	}

	generateBody := map[string]any{"workspaceId": workspaceID, "prompt": fixture.UserPrompt, "hint": "auto"}

	// A viewer is refused before anything is created.
	if code, body, _ := call(viewerID, http.MethodPost, "/api/v1/plans/generate", generateBody); code != http.StatusForbidden || nested(body, "error", "code") != "PLAN_FORBIDDEN" {
		t.Fatalf("viewer generate = %d %v", code, body)
	}

	// The happy path: 202, the stage while running, a valid plan at the end.
	chat.replies[roleNames[modelgateway.RoleClassifier]] = []string{fixture.ModelReplies.Intent}
	chat.replies[roleNames[modelgateway.RolePlanner]] = []string{fixture.ModelReplies.Planner[0]}
	chat.replies[roleNames[modelgateway.RoleCritic]] = []string{fixture.ModelReplies.Critic[0]}
	gate := make(chan struct{})
	chat.gates[roleNames[modelgateway.RolePlanner]] = gate
	code, body, headers := call(memberID, http.MethodPost, "/api/v1/plans/generate", generateBody)
	if code != http.StatusAccepted || nested(body, "generation", "status") != "running" || headers.Get("Location") == "" {
		t.Fatalf("generate = %d %v", code, body)
	}
	planID, _ := body["id"].(string)
	running := waitFor(planID, func(body map[string]any) bool { return nested(body, "generation", "stage") == "generate" })
	if nested(running, "generation", "status") != "running" || running["plan"] != nil {
		t.Fatalf("running plan = %v", running)
	}
	if code, body, _ := call(memberID, http.MethodPost, "/api/v1/plans/"+planID+"/approve", map[string]any{}); code != http.StatusConflict || nested(body, "error", "code") != "PLAN_BUSY" {
		t.Fatalf("approve while running = %d %v", code, body)
	}
	close(gate)
	final := waitFor(planID, func(body map[string]any) bool { return nested(body, "generation", "status") != "running" })
	if nested(final, "generation", "status") != "succeeded" || nested(final, "validation", "status") != "valid" || nested(final, "generation", "stage") != nil {
		t.Fatalf("final plan = %v", final)
	}
	issues, _ := nested(final, "plan", "issues").([]any)
	if len(issues) != 2 || nested(issues[0].(map[string]any), "suggestedAgentId") != agentID.String() {
		t.Fatalf("issues = %v", issues)
	}
	if errors, _ := nested(final, "validation", "errors").([]any); len(errors) != 0 {
		t.Fatalf("validation errors = %v", errors)
	}
	if final["plannerVersion"] != prompts.Planner().Version || final["version"] != float64(1) {
		t.Fatalf("version fields = %v %v", final["plannerVersion"], final["version"])
	}

	// Stage records: one per stage, usage on the role calls, no prompt text.
	code, body, _ = call(memberID, http.MethodGet, "/api/v1/plans/"+planID+"/events", nil)
	if code != http.StatusOK {
		t.Fatalf("events = %d %v", code, body)
	}
	nodes, _ := body["nodes"].([]any)
	var stages []string
	for _, node := range nodes {
		event := node.(map[string]any)
		stages = append(stages, event["stage"].(string)+":"+event["outcome"].(string))
		detail, _ := json.Marshal(event["detail"])
		if strings.Contains(string(detail), fixture.UserPrompt) || strings.Contains(string(detail), "berry-plan/1") {
			t.Fatalf("planner event leaks content: %s", detail)
		}
		if event["role"] != nil && (event["inputTokens"] == nil || event["promptVersion"] == nil || event["modelName"] == nil) {
			t.Fatalf("role event without usage: %v", event)
		}
	}
	if got := strings.Join(stages, ","); got != "intent:ok,context:ok,generate:ok,validate:ok,critic:ok" {
		t.Fatalf("stages = %s", got)
	}

	// Progress facts reached the outbox for the workspace stream.
	rows, err := pool.Query(ctx, `SELECT topic FROM outbox_events WHERE aggregate_type = 'plan' AND aggregate_id = $1`, planID)
	if err != nil {
		t.Fatalf("outbox: %v", err)
	}
	topics := map[string]int{}
	for rows.Next() {
		var topic string
		_ = rows.Scan(&topic)
		topics[topic]++
	}
	rows.Close()
	if topics["plan.updated"] < 4 || topics["plan.generated"] != 1 {
		t.Fatalf("outbox topics = %v", topics)
	}

	// Start Plan compiles the valid plan.
	if code, body, _ := call(memberID, http.MethodPost, "/api/v1/plans/"+planID+"/approve", map[string]any{}); code != http.StatusOK || nested(body, "compile", "status") != "succeeded" {
		t.Fatalf("approve = %d %v", code, body)
	}

	// An invalid plan whose repairs ran out cannot start.
	broken := strings.Replace(fixture.ModelReplies.Planner[0], `"workflows":[]`, `"workflows":[{"tempId":"w_1","name":"Nope","trigger":{"id":"t","type":"manual"},"steps":[{"id":"s","type":"action","provider":"stripe","operation":"charge","input":{}}],"entry":["s"]}]`, 1)
	chat.replies[roleNames[modelgateway.RoleClassifier]] = []string{fixture.ModelReplies.Intent}
	chat.replies[roleNames[modelgateway.RolePlanner]] = []string{broken}
	chat.replies[roleNames[modelgateway.RoleRepair]] = []string{broken}
	code, body, _ = call(memberID, http.MethodPost, "/api/v1/plans/generate", generateBody)
	if code != http.StatusAccepted {
		t.Fatalf("second generate = %d %v", code, body)
	}
	invalidID, _ := body["id"].(string)
	invalid := waitFor(invalidID, func(body map[string]any) bool { return nested(body, "generation", "status") != "running" })
	if nested(invalid, "generation", "status") != "failed" || nested(invalid, "generation", "error") != "PLAN_INVALID" || nested(invalid, "validation", "status") != "invalid" {
		t.Fatalf("invalid plan = %v", invalid)
	}
	if errors, _ := nested(invalid, "validation", "errors").([]any); len(errors) == 0 || errors[0].(map[string]any)["code"] != "TOOL_UNKNOWN" {
		t.Fatalf("invalid plan errors = %v", nested(invalid, "validation", "errors"))
	}
	for _, path := range []string{"/approve", "/compile"} {
		if code, body, _ := call(adminID, http.MethodPost, "/api/v1/plans/"+invalidID+path, map[string]any{}); code != http.StatusConflict || nested(body, "error", "code") != "PLAN_INVALID" {
			t.Fatalf("%s invalid = %d %v", path, code, body)
		}
	}
	if chat.calls[roleNames[modelgateway.RoleRepair]] != 1 {
		t.Fatalf("repair calls = %d, want the one bounded attempt", chat.calls[roleNames[modelgateway.RoleRepair]])
	}

	// Roles are for admins.
	if code, _, _ := call(memberID, http.MethodGet, "/api/v1/plans/roles", nil); code != http.StatusForbidden {
		t.Fatalf("member roles = %d", code)
	}
	code, body, _ = call(adminID, http.MethodGet, "/api/v1/plans/roles", nil)
	roles, _ := body["roles"].([]any)
	if code != http.StatusOK || body["enabled"] != true || len(roles) != 4 {
		t.Fatalf("admin roles = %d %v", code, body)
	}
}
