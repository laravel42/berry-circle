package triggerdispatch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/orchestration/orchestrationtest"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	corerepo "github.com/laravel42/berry-circle/server/internal/repository/core"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
	approvalsvc "github.com/laravel42/berry-circle/server/internal/service/approvals"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// clock is a settable clock so timers and expiries are deterministic.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Advance(by time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(by)
}

// syncStarter executes runs inline so a tick's effects are visible when
// RunOnce returns.
type syncStarter struct {
	runner *automationrun.Runner
}

func (starter syncStarter) Start(ctx context.Context, runID uuid.UUID) error {
	starter.runner.Execute(ctx, runID)
	return nil
}

func (starter syncStarter) Resume(ctx context.Context, runID uuid.UUID, signal automationrun.ResumeSignal) error {
	starter.runner.Resume(ctx, runID, signal)
	return nil
}

type fixture struct {
	pool        *pgxpool.Pool
	clock       *clock
	userID      uuid.UUID
	workspaceID uuid.UUID
	boardID     uuid.UUID
	agentID     uuid.UUID
	automations *automationrepo.Repository
	issues      *corerepo.Repository
	approvals   *approvalrepo.Repository
	goals       *goalrepo.Repository
	dispatcher  *Dispatcher
	// temporal is set when the fixture runs through the Temporal starter.
	temporal *orchestrationtest.Client
}

// starterMode selects how the fixture executes runs: inline, the way the
// in-process pool does once the queue drains, or through the real Temporal
// starter and orchestration over the test suite.
type starterMode string

const (
	modeInProcess starterMode = "in-process"
	modeTemporal  starterMode = "temporal"
)

// seeder builds a fixture; each scenario runs once per starter mode.
type seeder func(t *testing.T, ctx context.Context) fixture

func seed(t *testing.T, ctx context.Context) fixture {
	t.Helper()
	return seedWith(t, ctx, modeInProcess)
}

func seedTemporal(t *testing.T, ctx context.Context) fixture {
	t.Helper()
	return seedWith(t, ctx, modeTemporal)
}

func seedWith(t *testing.T, ctx context.Context, mode starterMode) fixture {
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
		pool: pool, clock: &clock{now: time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)},
		userID: uuid.New(), workspaceID: uuid.New(), boardID: uuid.New(), agentID: uuid.New(),
	}
	t.Cleanup(func() {
		// A workspace cannot be deleted: its protected orchestrator agent can
		// be neither removed nor unprotected, and agents.workspace_id
		// restricts. Everything that would pollute a global query goes:
		// boards cascade issues, runs and attachments; then the workspace's
		// own agent, workflows, goals, approvals, memberships and the user.
		cleanup := context.Background()
		for _, statement := range []string{
			`DELETE FROM outbox_events WHERE workspace_id = $1`,
			`DELETE FROM boards WHERE workspace_id = $1`,
			`DELETE FROM agents WHERE workspace_id = $1 AND NOT protected`,
			`DELETE FROM automations WHERE workspace_id = $1`,
			`DELETE FROM approvals WHERE workspace_id = $1`,
			`DELETE FROM goals WHERE workspace_id = $1`,
			`DELETE FROM workspace_memberships WHERE workspace_id = $1`,
		} {
			if _, err := pool.Exec(cleanup, statement, seeded.workspaceID); err != nil {
				t.Errorf("cleanup %q: %v", statement, err)
			}
		}
		if _, err := pool.Exec(cleanup, `DELETE FROM users WHERE id = $1`, seeded.userID); err != nil {
			t.Errorf("cleanup users: %v", err)
		}
	})
	now := seeded.clock.Now()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Dispatch', 'member', $3, $3)`,
		seeded.userID, fmt.Sprintf("%s@berry.test", seeded.userID), now)
	exec(`INSERT INTO workspaces (id, name, slug, settings, created_by, created_at, updated_at) VALUES ($1, 'Dispatch', $2, '{"issuePrefix":"DSP"}'::jsonb, $3, $4, $4)`,
		seeded.workspaceID, "dsp-"+seeded.workspaceID.String()[:8], seeded.userID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		seeded.workspaceID, seeded.userID, now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Dispatch', $3, $4, $5, $5)`,
		seeded.boardID, seeded.workspaceID, "b"+seeded.boardID.String()[:8], seeded.userID, now)
	exec(`INSERT INTO agents (id, workspace_id, openfang_agent_id, name, status, created_at, updated_at) VALUES ($1, $2, gen_random_uuid(), 'writer', 'available', $3, $3)`,
		seeded.agentID, seeded.workspaceID, now)
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("repository: %v", err)
		}
	}
	var repoErr error
	seeded.automations, repoErr = automationrepo.New(pool)
	must(repoErr)
	seeded.issues, repoErr = corerepo.New(pool)
	must(repoErr)
	seeded.approvals, repoErr = approvalrepo.New(pool)
	must(repoErr)
	seeded.goals, repoErr = goalrepo.New(pool)
	must(repoErr)
	directory := automationrun.Directory{Pool: pool}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	runner, err := automationrun.New(automationrun.Options{
		Store: seeded.automations, Issues: seeded.issues, Approvals: seeded.approvals, Goals: seeded.goals,
		Agents: directory, Boards: directory, Clock: seeded.clock.Now, NewID: uuid.New, Logger: logger,
	})
	must(err)
	var starter automationrun.Starter = syncStarter{runner: runner}
	if mode == modeTemporal {
		seeded.temporal = orchestrationtest.NewClient(&orchestration.Activities{
			Automations: runner, AutomationRuns: seeded.automations, ScheduledRuns: seeded.automations, Logger: logger,
		})
		t.Cleanup(seeded.temporal.Close)
		temporal, err := orchestration.NewAutomationStarter(seeded.temporal, "berry-runs")
		must(err)
		starter = temporal
	}
	workspaceID := seeded.workspaceID
	seeded.dispatcher, err = New(Options{
		Store: seeded.automations, Issues: seeded.issues, Goals: seeded.goals, Starter: starter,
		Clock: seeded.clock.Now, NewID: uuid.New, Logger: logger, WorkspaceID: &workspaceID,
	})
	must(err)
	return seeded
}

func (seeded fixture) tick(t *testing.T, ctx context.Context) Result {
	t.Helper()
	seeded.clock.Advance(time.Second)
	result, err := seeded.dispatcher.RunOnce(ctx, 100)
	if err != nil {
		t.Fatalf("RunOnce() error = %v", err)
	}
	return result
}

func (seeded fixture) activeAutomation(t *testing.T, ctx context.Context, definition string, goalID *uuid.UUID) automationrepo.Automation {
	t.Helper()
	parsed, findings := automation.ParseDefinition([]byte(definition))
	if len(findings) > 0 {
		t.Fatalf("definition: %+v", findings)
	}
	if report := automation.ValidateDefinition(parsed, automation.ValidateOptions{}); !report.Valid() {
		t.Fatalf("definition invalid: %+v", report.Errors)
	}
	created, _, err := seeded.automations.Create(ctx, automationrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, GoalID: goalID, Name: "Dispatch", Definition: parsed,
		CreatedBy: seeded.userID, CreatedAt: seeded.clock.Now(),
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	active, _, err := seeded.automations.SetStatus(ctx, created.ID, automationrepo.StatusActive, seeded.userID, seeded.clock.Now().Add(time.Millisecond), nil)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}
	return active
}

func (seeded fixture) createIssue(t *testing.T, ctx context.Context, title, status string) corerepo.Issue {
	t.Helper()
	issue, _, err := seeded.issues.CreateIssue(ctx, corerepo.CreateIssueParams{
		ID: uuid.New(), AssignmentID: uuid.New(), BoardID: seeded.boardID, Title: title, Status: status, Priority: "none",
		CreatedBy: seeded.userID, CreatedAt: seeded.clock.Now(),
	})
	if err != nil {
		t.Fatalf("CreateIssue(%s) error = %v", title, err)
	}
	return issue
}

func (seeded fixture) move(t *testing.T, ctx context.Context, issueID uuid.UUID, statuses ...string) {
	t.Helper()
	for _, status := range statuses {
		seeded.clock.Advance(time.Millisecond)
		target := status
		if _, _, err := seeded.issues.UpdateIssue(ctx, corerepo.UpdateIssueParams{
			IssueID: issueID, Patch: corerepo.IssuePatch{Status: &target}, AssignmentID: uuid.New(),
			AssignedBy: seeded.userID, UpdatedAt: seeded.clock.Now(),
		}); err != nil {
			t.Fatalf("UpdateIssue(%s → %s) error = %v", issueID, status, err)
		}
	}
}

func (seeded fixture) runsOf(t *testing.T, ctx context.Context, automationID uuid.UUID) []automationrepo.Run {
	t.Helper()
	runs, err := seeded.automations.ListRuns(ctx, automationrepo.RunListFilter{WorkspaceID: seeded.workspaceID, AutomationID: &automationID}, nil, 50)
	if err != nil {
		t.Fatalf("ListRuns() error = %v", err)
	}
	return runs
}

func (seeded fixture) receiptFor(t *testing.T, ctx context.Context, topic string, aggregateID uuid.UUID) automationrepo.Receipt {
	t.Helper()
	var eventID uuid.UUID
	if err := seeded.pool.QueryRow(ctx,
		`SELECT id FROM outbox_events WHERE workspace_id = $1 AND topic = $2 AND aggregate_id = $3 ORDER BY occurred_at DESC LIMIT 1`,
		seeded.workspaceID, topic, aggregateID,
	).Scan(&eventID); err != nil {
		t.Fatalf("find %s event for %s: %v", topic, aggregateID, err)
	}
	receipt, err := seeded.automations.GetReceipt(ctx, eventID)
	if err != nil {
		t.Fatalf("GetReceipt(%s) error = %v", eventID, err)
	}
	return receipt
}

func (seeded fixture) status(t *testing.T, ctx context.Context, issueID uuid.UUID) string {
	t.Helper()
	issue, err := seeded.issues.GetIssue(ctx, issueID.String())
	if err != nil {
		t.Fatalf("GetIssue() error = %v", err)
	}
	return issue.Status
}

const followUp = `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},"entry":["notify"],"steps":[
	{"id":"notify","type":"create_issue","title":"Follow up {{ trigger.issue.identifier }}","assignAgentId":"%s"}
]}`

// The P1b acceptance path: an active workflow on issue.completed, an issue
// moved to done, one tick, a run with step rows, a created issue with its
// provenance and goal link, and a matched receipt.
func TestDispatcherMatchesEventsIntoRunsWithStepsAndReceipts(t *testing.T) {
	matchScenario(t, context.Background(), seed)
}

func matchScenario(t *testing.T, ctx context.Context, newFixture seeder) {
	seeded := newFixture(t, ctx)
	goal, _, err := seeded.goals.Create(ctx, goalrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Title: "Launch", Status: goalrepo.StatusActive,
		Source: goalrepo.SourceManual, CreatedBy: seeded.userID, CreatedAt: seeded.clock.Now(),
	})
	if err != nil {
		t.Fatalf("goals.Create() error = %v", err)
	}
	item := seeded.activeAutomation(t, ctx, fmt.Sprintf(followUp, seeded.agentID), &goal.ID)
	seeded.tick(t, ctx) // consume the seed facts

	issue := seeded.createIssue(t, ctx, "Ship", "todo")
	seeded.move(t, ctx, issue.ID, "in_progress", "in_review", "done")
	result := seeded.tick(t, ctx)
	if result.Started != 1 {
		t.Fatalf("result = %+v, want one started run", result)
	}
	runs := seeded.runsOf(t, ctx, item.ID)
	if len(runs) != 1 || runs[0].Status != automationrepo.RunSucceeded || runs[0].TriggerType != automation.TriggerBerryEvent ||
		runs[0].GoalID == nil || *runs[0].GoalID != goal.ID || runs[0].RequestedBy == nil || *runs[0].RequestedBy != seeded.userID {
		t.Fatalf("runs = %+v", runs)
	}
	var trigger map[string]any
	_ = json.Unmarshal(runs[0].TriggerPayload, &trigger)
	if trigger["topic"] != "issue.completed" || trigger["issue"].(map[string]any)["identifier"] != issue.Identifier() {
		t.Fatalf("trigger payload = %v", trigger)
	}
	_, steps, err := seeded.automations.GetRunWithSteps(ctx, runs[0].ID)
	if err != nil || len(steps) != 1 || steps[0].Status != automationrepo.StepSucceeded || steps[0].IssueID == nil {
		t.Fatalf("steps = %+v, %v", steps, err)
	}
	created, err := seeded.issues.GetIssue(ctx, steps[0].IssueID.String())
	if err != nil || created.Title != "Follow up "+issue.Identifier() || created.Assignee == nil || created.Assignee.ID != seeded.agentID {
		t.Fatalf("created issue = %+v, %v", created, err)
	}
	origin, err := seeded.automations.GetIssueOrigin(ctx, created.ID)
	if err != nil || origin.AutomationID != item.ID || origin.RunID != runs[0].ID || origin.StepRunID == nil || *origin.StepRunID != steps[0].ID {
		t.Fatalf("origin = %+v, %v", origin, err)
	}
	if linked, err := seeded.goals.GoalForIssue(ctx, created.ID); err != nil || linked != goal.ID {
		t.Fatalf("goal link = %v, %v", linked, err)
	}
	receipt := seeded.receiptFor(t, ctx, "issue.completed", issue.ID)
	if receipt.Outcome != automationrepo.ReceiptMatched || receipt.MatchedCount != 1 || receipt.Reason != "" {
		t.Fatalf("receipt = %+v", receipt)
	}
	events, err := seeded.automations.ListRunEvents(ctx, runs[0].ID, -1, seeded.clock.Now().Add(-time.Hour), 50)
	if err != nil {
		t.Fatalf("ListRunEvents() error = %v", err)
	}
	var types []string
	for _, event := range events {
		types = append(types, event.Type)
	}
	if strings.Join(types, ",") != "workflow.run.started,workflow.step.started,workflow.step.succeeded,workflow.run.succeeded" {
		t.Fatalf("ledger = %v", types)
	}
	// A second tick finds nothing new: the receipt is final.
	if again := seeded.tick(t, ctx); again.Started != 0 || len(seeded.runsOf(t, ctx, item.ID)) != 1 {
		t.Fatalf("second tick = %+v", again)
	}
	if seeded.temporal != nil {
		workflowID := orchestration.AutomationRunWorkflowID(runs[0].ID)
		if seeded.temporal.Starts() != 1 || seeded.temporal.Running(workflowID) {
			t.Fatalf("temporal starts = %d, running = %v; want one finished orchestration", seeded.temporal.Starts(), seeded.temporal.Running(workflowID))
		}
	}
}

func TestDispatcherTriggerFilterAndIdempotency(t *testing.T) {
	filterScenario(t, context.Background(), seed)
}

func filterScenario(t *testing.T, ctx context.Context, newFixture seeder) {
	seeded := newFixture(t, ctx)
	item := seeded.activeAutomation(t, ctx, `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed","config":{"filter":{"op":"equals","left":{"ref":"trigger.issue.priority"},"right":"urgent"}}},"entry":["notify"],"steps":[
		{"id":"notify","type":"create_issue","title":"Urgent follow up"}
	]}`, nil)
	seeded.tick(t, ctx)
	quiet := seeded.createIssue(t, ctx, "Quiet", "todo")
	seeded.move(t, ctx, quiet.ID, "in_progress", "in_review", "done")
	seeded.tick(t, ctx)
	if runs := seeded.runsOf(t, ctx, item.ID); len(runs) != 0 {
		t.Fatalf("filtered event created runs: %+v", runs)
	}
	if receipt := seeded.receiptFor(t, ctx, "issue.completed", quiet.ID); receipt.Outcome != automationrepo.ReceiptUnmatched {
		t.Fatalf("receipt = %+v", receipt)
	}
}

// Two dispatchers claiming the same event at once create exactly one run.
func TestDispatcherConcurrentTicksCreateOneRun(t *testing.T) {
	concurrentScenario(t, context.Background(), seed)
}

func concurrentScenario(t *testing.T, ctx context.Context, newFixture seeder) {
	seeded := newFixture(t, ctx)
	item := seeded.activeAutomation(t, ctx, `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},"entry":["notify"],"steps":[
		{"id":"notify","type":"create_issue","title":"Once"}
	]}`, nil)
	seeded.tick(t, ctx)
	issue := seeded.createIssue(t, ctx, "Race", "todo")
	seeded.move(t, ctx, issue.ID, "in_progress", "in_review", "done")
	seeded.clock.Advance(time.Second)
	var wait sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := seeded.dispatcher.RunOnce(ctx, 100)
			errs <- err
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("RunOnce() error = %v", err)
		}
	}
	if runs := seeded.runsOf(t, ctx, item.ID); len(runs) != 1 || runs[0].Status != automationrepo.RunSucceeded {
		t.Fatalf("runs = %+v, want exactly one", runs)
	}
	var created int
	_ = seeded.pool.QueryRow(ctx, `SELECT count(*) FROM issues WHERE board_id = $1 AND title = 'Once'`, seeded.boardID).Scan(&created)
	if created != 1 {
		t.Fatalf("issues titled Once = %d, want exactly one", created)
	}
	if seeded.temporal != nil && seeded.temporal.Starts() != 1 {
		t.Fatalf("temporal starts = %d, want exactly one orchestration", seeded.temporal.Starts())
	}
}

func TestDispatcherResumesApprovalWaits(t *testing.T) {
	approvalScenario(t, context.Background(), seed)
}

func approvalScenario(t *testing.T, _ context.Context, newFixture seeder) {
	definition := `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},"entry":["gate"],"steps":[
		{"id":"gate","type":"approval","title":"Ship {{ trigger.issue.identifier }}?","approver":{"type":"role","role":"admin"},"timeout":"PT1H"},
		{"id":"ship","type":"create_issue","title":"Shipped","dependsOn":["gate"]}
	]}`
	cases := []struct {
		name     string
		decide   func(t *testing.T, ctx context.Context, seeded fixture, approvalID uuid.UUID)
		wantRun  automationrepo.RunStatus
		wantCode string
	}{
		{
			name: "approve resumes",
			decide: func(t *testing.T, ctx context.Context, seeded fixture, approvalID uuid.UUID) {
				if _, _, err := seeded.approvals.Resolve(ctx, approvalID, approvalrepo.Resolution{Decision: approvalrepo.DecisionApproved, ActorID: seeded.userID, Now: seeded.clock.Now()}); err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
			},
			wantRun: automationrepo.RunSucceeded,
		},
		{
			name: "reject fails",
			decide: func(t *testing.T, ctx context.Context, seeded fixture, approvalID uuid.UUID) {
				if _, _, err := seeded.approvals.Resolve(ctx, approvalID, approvalrepo.Resolution{Decision: approvalrepo.DecisionRejected, ActorID: seeded.userID, Now: seeded.clock.Now()}); err != nil {
					t.Fatalf("Resolve() error = %v", err)
				}
			},
			wantRun: automationrepo.RunFailed, wantCode: "APPROVAL_REJECTED",
		},
		{
			name: "expiry sweep fails",
			decide: func(t *testing.T, ctx context.Context, seeded fixture, _ uuid.UUID) {
				seeded.clock.Advance(2 * time.Hour)
				sweeper, err := approvalsvc.NewSweeper(approvalsvc.SweeperOptions{Store: seeded.approvals, Clock: seeded.clock.Now, NewID: uuid.New, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
				if err != nil {
					t.Fatalf("NewSweeper() error = %v", err)
				}
				if count, err := sweeper.RunOnce(ctx); err != nil || count < 1 {
					t.Fatalf("RunOnce() = %d, %v", count, err)
				}
			},
			wantRun: automationrepo.RunFailed, wantCode: "APPROVAL_EXPIRED",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			seeded := newFixture(t, ctx)
			item := seeded.activeAutomation(t, ctx, definition, nil)
			seeded.tick(t, ctx)
			issue := seeded.createIssue(t, ctx, "Gate me", "todo")
			seeded.move(t, ctx, issue.ID, "in_progress", "in_review", "done")
			seeded.tick(t, ctx)
			runs := seeded.runsOf(t, ctx, item.ID)
			if len(runs) != 1 || runs[0].Status != automationrepo.RunWaiting || runs[0].WaitingOn == nil || !strings.HasPrefix(*runs[0].WaitingOn, "approval:") {
				t.Fatalf("runs = %+v", runs)
			}
			approvalID := uuid.MustParse(strings.TrimPrefix(*runs[0].WaitingOn, "approval:"))
			approval, err := seeded.approvals.Get(ctx, approvalID)
			if err != nil || approval.Kind != approvalrepo.KindAutomationStep || approval.Title != "Ship "+issue.Identifier()+"?" ||
				approval.AutomationRunID == nil || *approval.AutomationRunID != runs[0].ID || approval.ExpiresAt == nil {
				t.Fatalf("approval = %+v, %v", approval, err)
			}
			test.decide(t, ctx, seeded, approvalID)
			result := seeded.tick(t, ctx)
			if result.Resumed != 1 {
				t.Fatalf("result = %+v, want one resume", result)
			}
			run, steps, err := seeded.automations.GetRunWithSteps(ctx, runs[0].ID)
			if err != nil || run.Status != test.wantRun {
				t.Fatalf("run = %+v, %v", run, err)
			}
			if test.wantCode != "" {
				if run.Failure == nil || run.Failure.Code != test.wantCode || steps[0].Failure == nil || steps[0].Failure.Code != test.wantCode {
					t.Fatalf("failure = %+v, steps = %+v", run.Failure, steps)
				}
				return
			}
			if len(steps) != 2 || steps[1].StepID != "ship" || steps[1].Status != automationrepo.StepSucceeded {
				t.Fatalf("steps = %+v", steps)
			}
		})
	}
}

func TestDispatcherResumesTimerWaits(t *testing.T) {
	timerScenario(t, context.Background(), seed)
}

func timerScenario(t *testing.T, ctx context.Context, newFixture seeder) {
	seeded := newFixture(t, ctx)
	item := seeded.activeAutomation(t, ctx, `{"version":"1","trigger":{"id":"on_done","type":"berry_event","event":"issue.completed"},"entry":["pause"],"steps":[
		{"id":"pause","type":"wait","mode":"duration","duration":"PT10M"},
		{"id":"then","type":"create_issue","title":"Later","dependsOn":["pause"]}
	]}`, nil)
	seeded.tick(t, ctx)
	issue := seeded.createIssue(t, ctx, "Wait", "todo")
	seeded.move(t, ctx, issue.ID, "in_progress", "in_review", "done")
	seeded.tick(t, ctx)
	runs := seeded.runsOf(t, ctx, item.ID)
	if len(runs) != 1 || runs[0].Status != automationrepo.RunWaiting || runs[0].ResumeAt == nil {
		t.Fatalf("runs = %+v", runs)
	}
	if result := seeded.tick(t, ctx); result.Timers != 0 {
		t.Fatalf("timer fired early: %+v", result)
	}
	seeded.clock.Advance(10 * time.Minute)
	if result := seeded.tick(t, ctx); result.Timers != 1 {
		t.Fatalf("result = %+v, want the timer resumed", result)
	}
	run, steps, _ := seeded.automations.GetRunWithSteps(ctx, runs[0].ID)
	if run.Status != automationrepo.RunSucceeded || len(steps) != 2 || steps[1].Status != automationrepo.StepSucceeded {
		t.Fatalf("run = %+v, steps = %+v", run, steps)
	}
}

// The run scenarios again through the Temporal starter: the real starter
// over the test suite, the real orchestration and activities, and the same
// runner and rows the in-process path uses (TEMPORAL_ENABLED=true).
func TestDispatcherScenariosThroughTemporal(t *testing.T) {
	scenarios := []struct {
		name string
		run  func(*testing.T, context.Context, seeder)
	}{
		{"match", matchScenario},
		{"filter", filterScenario},
		{"concurrent", concurrentScenario},
		{"approvals", approvalScenario},
		{"timers", timerScenario},
	}
	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			scenario.run(t, context.Background(), seedTemporal)
		})
	}
}

// Completing a blocker moves its dependents from blocked to todo through the
// issue writer (issue.updated is emitted); a dependent behind an approval
// gate stays blocked and the receipt says why.
func TestDispatcherReleasesDependentsUnlessGated(t *testing.T) {
	ctx := context.Background()
	seeded := seed(t, ctx)
	seeded.tick(t, ctx)
	blocker := seeded.createIssue(t, ctx, "Blocker", "todo")
	free := seeded.createIssue(t, ctx, "Free dependent", "blocked")
	gated := seeded.createIssue(t, ctx, "Gated dependent", "blocked")
	for _, dependent := range []corerepo.Issue{free, gated} {
		if err := seeded.issues.AddIssueDependency(ctx, corerepo.AddIssueDependencyParams{
			WorkspaceID: seeded.workspaceID, IssueID: dependent.ID, DependsOnIssueID: blocker.ID, CreatedBy: seeded.userID, CreatedAt: seeded.clock.Now(),
		}); err != nil {
			t.Fatalf("AddIssueDependency() error = %v", err)
		}
	}
	if _, _, err := seeded.approvals.Create(ctx, approvalrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Kind: approvalrepo.KindIssueStart, Title: "Start gated",
		IssueID: &gated.ID, RequestedFromRole: "admin", RequestedAt: seeded.clock.Now(),
	}); err != nil {
		t.Fatalf("approvals.Create() error = %v", err)
	}
	seeded.tick(t, ctx)
	seeded.move(t, ctx, blocker.ID, "in_progress", "in_review", "done")
	result := seeded.tick(t, ctx)
	if result.Released != 1 {
		t.Fatalf("result = %+v, want one release", result)
	}
	if seeded.status(t, ctx, free.ID) != "todo" || seeded.status(t, ctx, gated.ID) != "blocked" {
		t.Fatalf("free = %s, gated = %s", seeded.status(t, ctx, free.ID), seeded.status(t, ctx, gated.ID))
	}
	receipt := seeded.receiptFor(t, ctx, "issue.completed", blocker.ID)
	if receipt.Outcome != automationrepo.ReceiptMatched || !strings.Contains(receipt.Reason, gated.ID.String()) || !strings.Contains(receipt.Reason, "approval required") {
		t.Fatalf("receipt = %+v", receipt)
	}
	var previous string
	if err := seeded.pool.QueryRow(ctx,
		`SELECT payload->'payload'->>'previousStatus' FROM outbox_events WHERE workspace_id = $1 AND topic = 'issue.updated' AND aggregate_id = $2 ORDER BY occurred_at DESC LIMIT 1`,
		seeded.workspaceID, free.ID,
	).Scan(&previous); err != nil || previous != "blocked" {
		t.Fatalf("issue.updated for the release: previous = %q, %v", previous, err)
	}
}

func TestDispatcherAdvancesGoalsWithTheirIssues(t *testing.T) {
	ctx := context.Background()
	seeded := seed(t, ctx)
	goal, _, err := seeded.goals.Create(ctx, goalrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Title: "Launch", Status: goalrepo.StatusPlanned,
		Source: goalrepo.SourceManual, CreatedBy: seeded.userID, CreatedAt: seeded.clock.Now(),
	})
	if err != nil {
		t.Fatalf("goals.Create() error = %v", err)
	}
	first := seeded.createIssue(t, ctx, "First", "todo")
	second := seeded.createIssue(t, ctx, "Second", "todo")
	for _, issue := range []corerepo.Issue{first, second} {
		if err := seeded.goals.LinkIssue(ctx, seeded.workspaceID, goal.ID, issue.ID, seeded.userID, seeded.clock.Now()); err != nil {
			t.Fatalf("LinkIssue() error = %v", err)
		}
	}
	seeded.tick(t, ctx)
	seeded.move(t, ctx, first.ID, "in_progress")
	seeded.tick(t, ctx)
	if current, _ := seeded.goals.Get(ctx, goal.ID); current.Status != goalrepo.StatusActive || current.StartedAt == nil {
		t.Fatalf("goal after first start = %+v", current)
	}
	seeded.move(t, ctx, first.ID, "in_review", "done")
	seeded.tick(t, ctx)
	if current, _ := seeded.goals.Get(ctx, goal.ID); current.Status != goalrepo.StatusActive {
		t.Fatalf("goal completed early = %+v", current)
	}
	seeded.move(t, ctx, second.ID, "cancelled")
	seeded.tick(t, ctx)
	current, _ := seeded.goals.Get(ctx, goal.ID)
	if current.Status != goalrepo.StatusCompleted || current.CompletedAt == nil {
		t.Fatalf("goal = %+v, want completed", current)
	}
	var completed int
	_ = seeded.pool.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE workspace_id = $1 AND topic = 'goal.completed'`, seeded.workspaceID).Scan(&completed)
	if completed != 1 {
		t.Fatalf("goal.completed events = %d", completed)
	}
}

func TestHealthReportsAStalledDispatcher(t *testing.T) {
	t.Parallel()
	ticker := &clock{now: time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)}
	health := NewHealth(time.Minute, ticker.Now)
	if err := health.Check(context.Background()); err != nil {
		t.Fatalf("fresh probe failed: %v", err)
	}
	ticker.Advance(2 * time.Minute)
	if err := health.Check(context.Background()); err == nil {
		t.Fatal("stale probe passed")
	}
	health.MarkTick(ticker.Now())
	if err := health.Check(context.Background()); err != nil {
		t.Fatalf("probe after a tick failed: %v", err)
	}
}
