package automationrun

import (
	"context"
	"crypto/sha256"
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
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	collabrepo "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	corerepo "github.com/laravel42/berry-circle/server/internal/repository/core"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
	runrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
	"github.com/laravel42/berry-circle/server/internal/service/runadmission"
)

// dbFixture is a workspace with a board, a member, an agent and every
// repository the runner and the issue run service share in production.
type dbFixture struct {
	pool        *pgxpool.Pool
	now         time.Time
	userID      uuid.UUID
	workspaceID uuid.UUID
	boardID     uuid.UUID
	agentID     uuid.UUID
	upstreamID  uuid.UUID
	automations *automationrepo.Repository
	issues      *corerepo.Repository
	approvals   *approvalrepo.Repository
	goals       *goalrepo.Repository
	runs        *runrepo.Repository
	artifacts   *collabrepo.Repository
}

func seedDB(t *testing.T, ctx context.Context) dbFixture {
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
	seeded := dbFixture{
		pool: pool, now: time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC),
		userID: uuid.New(), workspaceID: uuid.New(), boardID: uuid.New(), agentID: uuid.New(), upstreamID: uuid.New(),
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
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Runner', 'member', $3, $3)`,
		seeded.userID, fmt.Sprintf("%s@berry.test", seeded.userID), seeded.now)
	exec(`INSERT INTO workspaces (id, name, slug, settings, created_by, created_at, updated_at) VALUES ($1, 'Runner', $2, '{"issuePrefix":"RUN"}'::jsonb, $3, $4, $4)`,
		seeded.workspaceID, "run-"+seeded.workspaceID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		seeded.workspaceID, seeded.userID, seeded.now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Runner', $3, $4, $5, $5)`,
		seeded.boardID, seeded.workspaceID, "b"+seeded.boardID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO agents (id, workspace_id, openfang_agent_id, name, status, created_at, updated_at) VALUES ($1, $2, $3, 'writer', 'available', $4, $4)`,
		seeded.agentID, seeded.workspaceID, seeded.upstreamID, seeded.now)
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
	seeded.runs, repoErr = runrepo.New(pool)
	must(repoErr)
	seeded.artifacts, repoErr = collabrepo.New(pool)
	must(repoErr)
	return seeded
}

// activeAutomation stores and activates a workflow.
func (seeded dbFixture) activeAutomation(t *testing.T, ctx context.Context, definition string, goalID *uuid.UUID) automationrepo.Automation {
	t.Helper()
	parsed, findings := automation.ParseDefinition([]byte(definition))
	if len(findings) > 0 {
		t.Fatalf("definition: %+v", findings)
	}
	if report := automation.ValidateDefinition(parsed, automation.ValidateOptions{}); !report.Valid() {
		t.Fatalf("definition invalid: %+v", report.Errors)
	}
	created, _, err := seeded.automations.Create(ctx, automationrepo.CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, GoalID: goalID, Name: "Native", Definition: parsed,
		CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	active, _, err := seeded.automations.SetStatus(ctx, created.ID, automationrepo.StatusActive, seeded.userID, seeded.now.Add(time.Second), nil)
	if err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}
	return active
}

// blockingStream is a fake OpenFang stream that can pause after an event so
// a test can look at the ledger mid-run.
type blockingStream struct {
	mu      sync.Mutex
	events  []openfang.StreamEvent
	index   int
	pauseAt int
	release chan struct{}
	done    bool
}

func (stream *blockingStream) Next() (openfang.StreamEvent, error) {
	stream.mu.Lock()
	index := stream.index
	stream.index++
	stream.mu.Unlock()
	if index == stream.pauseAt && stream.release != nil {
		<-stream.release
	}
	if index < len(stream.events) {
		return stream.events[index], nil
	}
	return openfang.StreamEvent{}, io.EOF
}

func (stream *blockingStream) RequestID() string { return "fake-stream" }

func (stream *blockingStream) Close() error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	stream.done = true
	return nil
}

type fakeRuntime struct {
	stream *blockingStream
}

func (runtime *fakeRuntime) ListAgents(context.Context) ([]openfang.AgentSummary, error) {
	return nil, nil
}

func (runtime *fakeRuntime) GetAgent(context.Context, uuid.UUID) (openfang.AgentDetail, error) {
	return openfang.AgentDetail{}, nil
}

func (runtime *fakeRuntime) DispatchMessage(context.Context, uuid.UUID, openfang.MessageRequest) (openfang.EventStream, error) {
	return runtime.stream, nil
}

func (runtime *fakeRuntime) StopAgent(context.Context, uuid.UUID) (openfang.StopResponse, error) {
	return openfang.StopResponse{}, nil
}

func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func (seeded dbFixture) outboxTopics(t *testing.T, ctx context.Context) map[string]int {
	t.Helper()
	rows, err := seeded.pool.Query(ctx, `SELECT topic FROM outbox_events WHERE workspace_id = $1`, seeded.workspaceID)
	if err != nil {
		t.Fatalf("outbox: %v", err)
	}
	defer rows.Close()
	topics := map[string]int{}
	for rows.Next() {
		var topic string
		if err := rows.Scan(&topic); err != nil {
			t.Fatalf("scan: %v", err)
		}
		topics[topic]++
	}
	return topics
}

// The contract every issue-mode agent step relies on: the runtime's done
// event closes a turn, not the run. The step stays waiting through two done
// events; it fails when the body ends without the terminal phase
// (run.failed RUN_INCOMPLETE) and succeeds, with the result text and the
// run's artifacts in its output, when the body ends after it.
func TestIssueModeAgentStepFollowsRunCompletionNotDone(t *testing.T) {
	cases := []struct {
		name       string
		terminal   bool
		wantRun    automationrepo.RunStatus
		wantStep   automationrepo.StepStatus
		wantCode   string
		wantAgent  string
		wantResult string
	}{
		{name: "two done events and no terminal phase", terminal: false, wantRun: automationrepo.RunFailed, wantStep: automationrepo.StepFailed, wantCode: "AGENT_RUN_FAILED", wantAgent: "agent.failed"},
		{name: "terminal phase before EOF", terminal: true, wantRun: automationrepo.RunSucceeded, wantStep: automationrepo.StepSucceeded, wantAgent: "agent.completed", wantResult: "Final report: the market grew twelve percent and the three leading vendors consolidated; details and sources follow in the attached document, which covers methodology, limitations, and the forecast for the next four quarters in enough depth to act on without further research from the reader."},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			seeded := seedDB(t, ctx)
			events := []openfang.StreamEvent{
				{Type: openfang.EventChunk, Content: "I'll research this."},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 10, OutputTokens: 2}},
				{Type: openfang.EventPhase, Phase: "tool_loop"},
				{Type: openfang.EventToolUse, Tool: "web_search"},
				{Type: openfang.EventToolResult, Tool: "web_search"},
				{Type: openfang.EventChunk, Content: test.wantResult + "Final report: the market grew twelve percent and the three leading vendors consolidated; details and sources follow in the attached document, which covers methodology, limitations, and the forecast for the next four quarters in enough depth to act on without further research from the reader."},
				{Type: openfang.EventDone, Usage: openfang.Usage{InputTokens: 20, OutputTokens: 4}},
			}
			if test.wantResult != "" {
				events[5].Content = test.wantResult
			}
			if test.terminal {
				events = append(events, openfang.StreamEvent{Type: openfang.EventPhase, Phase: "done"})
			}
			stream := &blockingStream{events: events, pauseAt: 7, release: make(chan struct{})}
			workerCtx, cancel := context.WithCancel(ctx)
			defer cancel()
			hub, err := realtime.NewHub(16)
			if err != nil {
				t.Fatalf("NewHub() error = %v", err)
			}
			defer hub.Close()
			issueRuns, err := runadmission.New(runadmission.Options{
				Store: seeded.runs, OpenFang: &fakeRuntime{stream: stream}, Broadcaster: hub, Clock: time.Now, NewID: uuid.New,
				WorkerContext: workerCtx, Workers: 1, QueueSize: 4, Comments: seeded.issues, AgentEvents: seeded.runs,
				Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				t.Fatalf("runadmission.New() error = %v", err)
			}
			defer func() {
				closeCtx, cancelClose := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancelClose()
				_ = issueRuns.Close(closeCtx)
			}()
			directory := Directory{Pool: seeded.pool}
			runner, err := New(Options{
				Store: seeded.automations, Issues: seeded.issues, Approvals: seeded.approvals, Goals: seeded.goals,
				IssueRuns: issueRuns, Artifacts: seeded.artifacts, Agents: directory, Boards: directory,
				Broadcaster: hub, Clock: time.Now, NewID: uuid.New, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				t.Fatalf("New() error = %v", err)
			}
			item := seeded.activeAutomation(t, ctx, `{"version":"1","trigger":{"id":"manual","type":"manual"},"entry":["work"],"steps":[
				{"id":"work","type":"agent","issueMode":"issue","agentId":"`+seeded.agentID.String()+`","instruction":"Research the market {{ trigger.input.topic }}"}
			]}`, nil)
			payload, _ := json.Marshal(map[string]any{"input": map[string]any{"topic": "for widgets"}})
			run, created, err := seeded.automations.CreateRun(ctx, automationrepo.CreateRunParams{
				ID: uuid.New(), AutomationID: item.ID, TriggerType: automation.TriggerManual, Payload: payload,
				RequestedBy: &seeded.userID, CreatedAt: seeded.now.Add(2 * time.Second),
			})
			if err != nil || !created {
				t.Fatalf("CreateRun() = %+v, %v, %v", run, created, err)
			}

			runner.Execute(ctx, run.ID)
			parked, steps, err := seeded.automations.GetRunWithSteps(ctx, run.ID)
			if err != nil {
				t.Fatalf("GetRunWithSteps() error = %v", err)
			}
			if parked.Status != automationrepo.RunWaiting || parked.WaitingOn == nil || !strings.HasPrefix(*parked.WaitingOn, "run:") ||
				len(steps) != 1 || steps[0].Status != automationrepo.StepWaiting || steps[0].IssueRunID == nil || steps[0].IssueID == nil {
				t.Fatalf("parked run = %+v, steps = %+v", parked, steps)
			}
			issueRunID := *steps[0].IssueRunID
			issue, err := seeded.issues.GetIssue(ctx, steps[0].IssueID.String())
			if err != nil || issue.Assignee == nil || issue.Assignee.ID != seeded.agentID || !strings.HasPrefix(issue.Title, "Research the market for widgets") {
				t.Fatalf("created issue = %+v, %v", issue, err)
			}
			var origin uuid.UUID
			if err := seeded.pool.QueryRow(ctx, `SELECT automation_run_id FROM automation_issue_origins WHERE issue_id = $1`, issue.ID).Scan(&origin); err != nil || origin != run.ID {
				t.Fatalf("issue origin = %v, %v", origin, err)
			}

			// The stream is paused after its second done event: the issue run is
			// still running and the workflow step must still be waiting.
			waitFor(t, "the second turn to be consumed", func() bool {
				stream.mu.Lock()
				defer stream.mu.Unlock()
				return stream.index > 7
			})
			issueRun, err := seeded.runs.Get(ctx, issueRunID)
			if err != nil || issueRun.Status != runrepo.StatusRunning {
				t.Fatalf("issue run mid-stream = %+v, %v (two done events must not complete it)", issueRun, err)
			}
			midway, midSteps, _ := seeded.automations.GetRunWithSteps(ctx, run.ID)
			if midway.Status != automationrepo.RunWaiting || midSteps[0].Status != automationrepo.StepWaiting {
				t.Fatalf("workflow moved on a per-turn done: run = %+v, step = %+v", midway, midSteps[0])
			}
			topics := seeded.outboxTopics(t, ctx)
			if topics["run.completed"] != 0 || topics["run.failed"] != 0 || topics["agent.started"] != 1 {
				t.Fatalf("outbox mid-stream = %v", topics)
			}

			close(stream.release)
			waitFor(t, "the issue run to end at EOF", func() bool {
				current, err := seeded.runs.Get(ctx, issueRunID)
				return err == nil && current.Terminal()
			})
			issueRun, _ = seeded.runs.Get(ctx, issueRunID)
			if test.terminal {
				if issueRun.Status != runrepo.StatusSucceeded {
					t.Fatalf("issue run = %+v", issueRun)
				}
				body := []byte("# Report\n")
				artifact, err := seeded.artifacts.ReserveRunArtifact(ctx, collabrepo.ReserveRunArtifactParams{
					ID: uuid.New(), RunID: issueRunID, Path: "report.md", ContentType: "text/markdown",
					SizeBytes: int64(len(body)), ChecksumSHA256: sha256.Sum256(body), CreatedAt: time.Now(),
				})
				if err != nil {
					t.Fatalf("ReserveRunArtifact() error = %v", err)
				}
				if _, _, err := seeded.artifacts.ActivateRunArtifact(ctx, issueRunID, artifact.ID, uuid.New(), time.Now()); err != nil {
					t.Fatalf("ActivateRunArtifact() error = %v", err)
				}
			} else if issueRun.Status != runrepo.StatusFailed || issueRun.Failure == nil || issueRun.Failure.Code != "RUN_INCOMPLETE" {
				t.Fatalf("issue run = %+v, want failed RUN_INCOMPLETE", issueRun)
			}
			waitFor(t, "the agent fact", func() bool {
				return seeded.outboxTopics(t, ctx)[test.wantAgent] == 1
			})

			// The dispatcher's job, done by hand here: the run's terminal fact
			// settles the step.
			outcome := "completed"
			if !test.terminal {
				outcome = "failed"
			}
			runner.Resume(ctx, run.ID, ResumeSignal{Kind: SignalRun, ID: issueRunID, Outcome: outcome, OccurredAt: time.Now()})
			finished, steps, err := seeded.automations.GetRunWithSteps(ctx, run.ID)
			if err != nil {
				t.Fatalf("GetRunWithSteps() error = %v", err)
			}
			if finished.Status != test.wantRun || steps[0].Status != test.wantStep {
				t.Fatalf("finished run = %+v, step = %+v", finished, steps[0])
			}
			if test.wantCode != "" {
				if steps[0].Failure == nil || steps[0].Failure.Code != test.wantCode || !strings.Contains(steps[0].Failure.Message, "RUN_INCOMPLETE") {
					t.Fatalf("step failure = %+v", steps[0].Failure)
				}
				return
			}
			var decoded struct {
				Result     string `json:"result"`
				Identifier string `json:"identifier"`
				Artifacts  []struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"artifacts"`
			}
			if err := json.Unmarshal(steps[0].Output, &decoded); err != nil {
				t.Fatalf("output %s: %v", steps[0].Output, err)
			}
			if decoded.Result != test.wantResult || decoded.Identifier != issue.Identifier() || len(decoded.Artifacts) != 1 || decoded.Artifacts[0].Name != "report.md" {
				t.Fatalf("output = %+v", decoded)
			}
			topics = seeded.outboxTopics(t, ctx)
			if topics["artifact.created"] != 1 || topics["attachment.created"] != 1 || topics["agent.completed"] != 1 || topics["workflow.run.succeeded"] != 1 {
				t.Fatalf("outbox = %v", topics)
			}
		})
	}
}
