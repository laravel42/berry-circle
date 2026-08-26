package automation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

const sampleDefinition = `{
  "version": "1",
  "trigger": {"id": "on_done", "type": "berry_event", "event": "issue.completed"},
  "entry": ["notify"],
  "steps": [
    {"id": "notify", "type": "create_issue", "title": "Follow up {{ trigger.issue.identifier }}"},
    {"id": "gate", "type": "approval", "title": "Ship?", "approver": {"type": "role", "role": "admin"}, "dependsOn": ["notify"]},
    {"id": "pause", "type": "wait", "mode": "duration", "duration": "PT5M", "dependsOn": ["gate"]}
  ]
}`

type fixture struct {
	pool        *pgxpool.Pool
	now         time.Time
	userID      uuid.UUID
	workspaceID uuid.UUID
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
		pool: pool, now: time.Date(2026, time.August, 25, 16, 0, 0, 0, time.UTC),
		userID: uuid.New(), workspaceID: uuid.New(),
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM outbox_events WHERE workspace_id = $1`, seeded.workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, seeded.workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, seeded.userID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Automation', 'member', $3, $3)`,
		seeded.userID, fmt.Sprintf("%s@berry.test", seeded.userID), seeded.now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Automation', $2, $3, $4, $4)`,
		seeded.workspaceID, "auto-"+seeded.workspaceID.String()[:8], seeded.userID, seeded.now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		seeded.workspaceID, seeded.userID, seeded.now)
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return repository, seeded
}

func definition(t *testing.T) automation.Definition {
	t.Helper()
	parsed, findings := automation.ParseDefinition([]byte(sampleDefinition))
	if len(findings) > 0 {
		t.Fatalf("sample definition: %+v", findings)
	}
	return parsed
}

func (seeded fixture) create(t *testing.T, ctx context.Context, repository *Repository) Automation {
	t.Helper()
	created, event, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Name: "Follow up", Definition: definition(t),
		CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if event.Type != "workflow.created" || event.WorkspaceID != seeded.workspaceID {
		t.Fatalf("created event = %+v", event)
	}
	return created
}

func (seeded fixture) activate(t *testing.T, ctx context.Context, repository *Repository, id uuid.UUID) Automation {
	t.Helper()
	active, event, err := repository.SetStatus(ctx, id, StatusActive, seeded.userID, seeded.now.Add(time.Minute), nil)
	if err != nil || active.Status != StatusActive || event.Type != "workflow.activated" {
		t.Fatalf("SetStatus(active) = %+v, %+v, %v", active, event, err)
	}
	return active
}

// The definition is stored as validated and read back identically, with the
// trigger and risk indexed beside it; every definition edit is a new version
// and a stale revision is refused.
func TestDefinitionRoundTripsWithIndexedMetadataAndVersions(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	created := seeded.create(t, ctx, repository)
	if created.Trigger.Type != automation.TriggerBerryEvent || created.Trigger.Event != "issue.completed" ||
		created.Risk != automation.RiskMedium || created.Version != 1 || created.Revision != 1 || created.Status != StatusDraft {
		t.Fatalf("created = %+v", created)
	}
	var stored, want any
	if err := json.Unmarshal(created.Definition, &stored); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(sampleDefinition), &want); err != nil {
		t.Fatal(err)
	}
	storedText, _ := json.Marshal(stored)
	wantText, _ := json.Marshal(want)
	if string(storedText) != string(wantText) {
		t.Fatalf("stored definition drifted:\n%s\n%s", storedText, wantText)
	}

	if _, err := repository.Update(ctx, UpdateParams{
		AutomationID: created.ID, ExpectedRevision: 99, ActorID: seeded.userID, UpdatedAt: seeded.now,
	}); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale revision = %v, want ErrRevisionConflict", err)
	}
	edited := definition(t)
	edited.Trigger.Event = "issue.*"
	updated, err := repository.Update(ctx, UpdateParams{
		AutomationID: created.ID, ExpectedRevision: 1, Definition: &edited, ActorID: seeded.userID, UpdatedAt: seeded.now.Add(time.Second),
	})
	if err != nil || updated.Version != 2 || updated.Revision != 2 || updated.Trigger.Event != "issue.*" {
		t.Fatalf("Update() = %+v, %v", updated, err)
	}
	versions, err := repository.ListVersions(ctx, created.ID)
	if err != nil || len(versions) != 2 || versions[0].Version != 2 || versions[1].Version != 1 {
		t.Fatalf("ListVersions() = %+v, %v", versions, err)
	}
	seeded.activate(t, ctx, repository, created.ID)
	if _, err := repository.Update(ctx, UpdateParams{
		AutomationID: created.ID, ExpectedRevision: 3, Definition: &edited, ActorID: seeded.userID, UpdatedAt: seeded.now,
	}); !errors.Is(err, ErrActive) {
		t.Fatalf("definition edit while active = %v, want ErrActive", err)
	}
	if err := repository.RotateWebhookSecret(ctx, created.ID, "s3cret", seeded.now); err != nil {
		t.Fatalf("RotateWebhookSecret() error = %v", err)
	}
	if _, ok, err := repository.WebhookSecretMatches(ctx, created.ID, "s3cret"); err != nil || !ok {
		t.Fatalf("WebhookSecretMatches(right) = %t, %v", ok, err)
	}
	if _, ok, _ := repository.WebhookSecretMatches(ctx, created.ID, "wrong"); ok {
		t.Fatal("WebhookSecretMatches accepted a wrong token")
	}
}

// Drafts never run; an active workflow runs once per source event no matter
// how many times the event is offered.
func TestRunsRequireAnActiveWorkflowAndDedupeOnTheSourceEvent(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	created := seeded.create(t, ctx, repository)
	key := "evt-" + uuid.NewString()
	if _, _, err := repository.CreateRun(ctx, CreateRunParams{
		ID: uuid.New(), AutomationID: created.ID, TriggerType: automation.TriggerBerryEvent, SourceEventKey: &key, CreatedAt: seeded.now,
	}); !errors.Is(err, ErrNotActive) {
		t.Fatalf("run on a draft = %v, want ErrNotActive", err)
	}
	seeded.activate(t, ctx, repository, created.ID)
	first, createdRun, err := repository.CreateRun(ctx, CreateRunParams{
		ID: uuid.New(), AutomationID: created.ID, TriggerType: automation.TriggerBerryEvent, SourceEventKey: &key, CreatedAt: seeded.now,
	})
	if err != nil || !createdRun || first.Status != RunPending || first.AutomationVersion != 1 {
		t.Fatalf("first CreateRun() = %+v, %t, %v", first, createdRun, err)
	}
	second, createdRun, err := repository.CreateRun(ctx, CreateRunParams{
		ID: uuid.New(), AutomationID: created.ID, TriggerType: automation.TriggerBerryEvent, SourceEventKey: &key, CreatedAt: seeded.now,
	})
	if err != nil || createdRun || second.ID != first.ID {
		t.Fatalf("second CreateRun() = %+v, %t, %v", second, createdRun, err)
	}
	runs, err := repository.ListRuns(ctx, RunListFilter{WorkspaceID: seeded.workspaceID, AutomationID: &created.ID}, nil, 10)
	if err != nil || len(runs) != 1 {
		t.Fatalf("ListRuns() = %d runs, %v", len(runs), err)
	}
}

// One run walks pending → running → waiting → running → succeeded with its
// steps; every transition is one ledger event replayed in sequence order and
// mirrored to the outbox with the same id.
func TestRunAndStepTransitionsWriteAReplayableLedger(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	created := seeded.create(t, ctx, repository)
	seeded.activate(t, ctx, repository, created.ID)
	run, _, err := repository.CreateRun(ctx, CreateRunParams{
		ID: uuid.New(), AutomationID: created.ID, TriggerType: automation.TriggerManual, RequestedBy: &seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	at := seeded.now
	tick := func() time.Time {
		at = at.Add(time.Second)
		return at
	}
	if _, _, err := repository.MarkWaiting(ctx, run.ID, "notify", "issue:x", nil, tick(), nil); !errors.Is(err, ErrRunState) {
		t.Fatalf("waiting before running = %v, want ErrRunState", err)
	}
	running, started, err := repository.MarkRunning(ctx, run.ID, tick(), nil)
	if err != nil || running.Status != RunRunning || started.Type != "workflow.run.started" || started.Sequence == nil || *started.Sequence != 0 {
		t.Fatalf("MarkRunning() = %+v, %+v, %v", running, started, err)
	}
	step, stepStarted, err := repository.StartStep(ctx, StartStepParams{
		ID: uuid.New(), RunID: run.ID, StepID: "notify", StepType: automation.StepCreateIssue, Input: json.RawMessage(`{"title":"x"}`), Now: tick(),
	})
	if err != nil || step.Status != StepRunning || stepStarted.Type != "workflow.step.started" {
		t.Fatalf("StartStep() = %+v, %+v, %v", step, stepStarted, err)
	}
	waiting, _, err := repository.WaitStep(ctx, step.ID, "issue:"+uuid.NewString(), StepLinks{}, tick(), nil)
	if err != nil || waiting.Status != StepWaiting {
		t.Fatalf("WaitStep() = %+v, %v", waiting, err)
	}
	parked, _, err := repository.MarkWaiting(ctx, run.ID, "notify", "issue:x", nil, tick(), nil)
	if err != nil || parked.Status != RunWaiting || parked.WaitingOn == nil || parked.CurrentStepID == nil || *parked.CurrentStepID != "notify" {
		t.Fatalf("MarkWaiting() = %+v, %v", parked, err)
	}
	resumed, _, err := repository.Resume(ctx, run.ID, tick(), nil)
	if err != nil || resumed.Status != RunRunning || resumed.WaitingOn != nil {
		t.Fatalf("Resume() = %+v, %v", resumed, err)
	}
	cost := int64(42)
	completedStep, _, err := repository.CompleteStep(ctx, step.ID, json.RawMessage(`{"id":"i1"}`),
		&automation.Usage{InputTokens: 10, OutputTokens: 5, CostMicros: &cost}, StepLinks{}, tick(), nil)
	if err != nil || completedStep.Status != StepSucceeded || string(completedStep.Output) != `{"id": "i1"}` {
		t.Fatalf("CompleteStep() = %+v, %v", completedStep, err)
	}
	if _, _, err := repository.CompleteStep(ctx, step.ID, nil, nil, StepLinks{}, tick(), nil); !errors.Is(err, ErrStepState) {
		t.Fatalf("second CompleteStep() = %v, want ErrStepState", err)
	}
	done, finished, err := repository.CompleteSuccess(ctx, run.ID, tick(), nil)
	if err != nil || done.Status != RunSucceeded || done.CompletedAt == nil || finished.Type != "workflow.run.succeeded" ||
		done.Usage.InputTokens != 10 || done.Usage.CostMicros == nil || *done.Usage.CostMicros != 42 {
		t.Fatalf("CompleteSuccess() = %+v, %+v, %v", done, finished, err)
	}
	if _, _, err := repository.Fail(ctx, run.ID, Failure{Code: "X", Message: "late"}, tick(), nil); !errors.Is(err, ErrRunTerminal) {
		t.Fatalf("Fail() after success = %v, want ErrRunTerminal", err)
	}

	events, err := repository.ListRunEvents(ctx, run.ID, -1, seeded.now.Add(-time.Hour), 100)
	if err != nil {
		t.Fatalf("ListRunEvents() error = %v", err)
	}
	wantTypes := []string{
		"workflow.run.started", "workflow.step.started", "workflow.step.waiting", "workflow.run.waiting",
		"workflow.run.resumed", "workflow.step.succeeded", "workflow.run.succeeded",
	}
	if len(events) != len(wantTypes) {
		t.Fatalf("replayed %d events, want %d", len(events), len(wantTypes))
	}
	var previous time.Time
	for index, event := range events {
		if event.Type != wantTypes[index] || event.Sequence != int64(index) || event.AutomationID != created.ID || event.WorkspaceID != seeded.workspaceID {
			t.Fatalf("event %d = %+v, want %s", index, event, wantTypes[index])
		}
		if !previous.IsZero() && !event.OccurredAt.After(previous) {
			t.Fatalf("event %d is not strictly later than its predecessor", index)
		}
		previous = event.OccurredAt
		if event.Type == "workflow.step.waiting" && (event.StepID == nil || *event.StepID != "notify") {
			t.Fatalf("step event without its step id: %+v", event)
		}
	}
	sequence, err := repository.ResolveRunCursor(ctx, run.ID, events[3].ID, seeded.now.Add(-time.Hour))
	if err != nil || sequence != 3 {
		t.Fatalf("ResolveRunCursor() = %d, %v", sequence, err)
	}
	if _, err := repository.ResolveRunCursor(ctx, run.ID, uuid.New(), seeded.now.Add(-time.Hour)); !errors.Is(err, ErrCursorExpired) {
		t.Fatalf("unknown cursor = %v, want ErrCursorExpired", err)
	}
	var mirrored int
	if err := seeded.pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox_events WHERE aggregate_type = 'automation_run' AND aggregate_id = $1
		    AND id IN (SELECT id FROM automation_run_events WHERE automation_run_id = $1)`, run.ID).Scan(&mirrored); err != nil || mirrored != len(wantTypes) {
		t.Fatalf("outbox mirrors %d of %d ledger events (err %v)", mirrored, len(wantTypes), err)
	}
	_, steps, err := repository.GetRunWithSteps(ctx, run.ID)
	if err != nil || len(steps) != 1 || steps[0].Status != StepSucceeded || steps[0].Usage == nil {
		t.Fatalf("GetRunWithSteps() = %+v, %v", steps, err)
	}
}

// Two dispatchers ticking at once each claim a disjoint share of the same
// events and neither sees an event twice; a receipted event is never
// offered again.
func TestConcurrentClaimsNeverHandTheSameEventToTwoDispatchers(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	topic := "test.trigger." + uuid.NewString()[:8]
	t.Cleanup(func() {
		_, _ = seeded.pool.Exec(context.Background(), `DELETE FROM outbox_events WHERE topic = $1`, topic)
	})
	const total = 6
	for index := range total {
		if _, err := seeded.pool.Exec(ctx,
			`INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
			 VALUES ($1, $2, 'issue', $3, $4, '{}'::jsonb, $5, $5)`,
			uuid.New(), topic, uuid.New(), seeded.workspaceID, seeded.now.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatalf("seed outbox event: %v", err)
		}
	}
	var (
		mu      sync.Mutex
		claimed = map[uuid.UUID]int{}
		wait    sync.WaitGroup
		errs    = make(chan error, 2)
		release = make(chan struct{})
	)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := repository.ClaimTriggerBatch(ctx, ClaimParams{Topics: []string{topic}, Limit: 3, Now: seeded.now.Add(time.Hour)},
				func(ctx context.Context, batch *TriggerBatch) error {
					mu.Lock()
					for _, event := range batch.Events() {
						claimed[event.ID]++
					}
					mu.Unlock()
					// Hold the locks until both dispatchers have claimed, so
					// the second cannot simply run after the first commits.
					<-release
					for _, event := range batch.Events() {
						if err := batch.WriteReceipt(ctx, event.ID, event.WorkspaceID, ReceiptUnmatched, 0, "", seeded.now); err != nil {
							return err
						}
					}
					return nil
				})
			errs <- err
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		count := len(claimed)
		mu.Unlock()
		if count == total || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	close(release)
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("ClaimTriggerBatch() error = %v", err)
		}
	}
	if len(claimed) != total {
		t.Fatalf("claimed %d distinct events, want %d", len(claimed), total)
	}
	for id, times := range claimed {
		if times != 1 {
			t.Fatalf("event %s was claimed %d times", id, times)
		}
	}
	again, err := repository.ClaimTriggerBatch(ctx, ClaimParams{Topics: []string{topic}, Limit: 10, Now: seeded.now.Add(time.Hour)},
		func(context.Context, *TriggerBatch) error { return nil })
	if err != nil || again != 0 {
		t.Fatalf("receipted events were offered again: %d, %v", again, err)
	}
}

// A Berry event matches an active workflow by exact topic or by aggregate
// wildcard, and a timer wait is resumed by the claim that takes it.
func TestMatchActiveAndTimerResume(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	exact := seeded.create(t, ctx, repository)
	seeded.activate(t, ctx, repository, exact.ID)
	wildcardDefinition := definition(t)
	wildcardDefinition.Trigger.Event = "issue.*"
	wildcard, _, err := repository.Create(ctx, CreateParams{
		ID: uuid.New(), WorkspaceID: seeded.workspaceID, Name: "Any issue", Definition: wildcardDefinition,
		CreatedBy: seeded.userID, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("Create(wildcard) error = %v", err)
	}
	seeded.activate(t, ctx, repository, wildcard.ID)
	draft := seeded.create(t, ctx, repository)
	matched, err := repository.MatchActive(ctx, seeded.workspaceID, "issue.completed")
	if err != nil || len(matched) != 2 {
		t.Fatalf("MatchActive(issue.completed) = %d matches, %v; want the exact and wildcard workflows", len(matched), err)
	}
	// Both were created at the same instant, so the (created_at, id) order
	// between them is whichever id sorts first; assert membership, not order.
	matchedIDs := map[uuid.UUID]bool{matched[0].ID: true, matched[1].ID: true}
	if !matchedIDs[exact.ID] || !matchedIDs[wildcard.ID] {
		t.Fatalf("MatchActive(issue.completed) matched %v, want %s and %s", matchedIDs, exact.ID, wildcard.ID)
	}
	for _, item := range matched {
		if item.ID == draft.ID {
			t.Fatal("a draft matched a trigger")
		}
	}
	if matched, err := repository.MatchActive(ctx, seeded.workspaceID, "issue.created"); err != nil || len(matched) != 1 || matched[0].ID != wildcard.ID {
		t.Fatalf("MatchActive(issue.created) = %+v, %v", matched, err)
	}

	run, _, err := repository.CreateRun(ctx, CreateRunParams{
		ID: uuid.New(), AutomationID: exact.ID, TriggerType: automation.TriggerManual, CreatedAt: seeded.now,
	})
	if err != nil {
		t.Fatalf("CreateRun() error = %v", err)
	}
	if _, _, err := repository.MarkRunning(ctx, run.ID, seeded.now.Add(time.Second), nil); err != nil {
		t.Fatalf("MarkRunning() error = %v", err)
	}
	resumeAt := seeded.now.Add(5 * time.Minute)
	if _, _, err := repository.MarkWaiting(ctx, run.ID, "pause", "timer", &resumeAt, seeded.now.Add(2*time.Second), nil); err != nil {
		t.Fatalf("MarkWaiting() error = %v", err)
	}
	early, _, err := repository.ClaimResumable(ctx, seeded.now.Add(time.Minute), 10, nil)
	if err != nil {
		t.Fatalf("ClaimResumable(early) error = %v", err)
	}
	for _, claimed := range early {
		if claimed.ID == run.ID {
			t.Fatal("a timer wait was resumed before its instant")
		}
	}
	due, events, err := repository.ClaimResumable(ctx, seeded.now.Add(10*time.Minute), 10, nil)
	if err != nil {
		t.Fatalf("ClaimResumable(due) error = %v", err)
	}
	found := false
	for index, claimed := range due {
		if claimed.ID == run.ID {
			found = true
			if claimed.Status != RunRunning || claimed.ResumeAt != nil || events[index].Type != "workflow.run.resumed" {
				t.Fatalf("resumed run = %+v event = %+v", claimed, events[index])
			}
		}
	}
	if !found {
		t.Fatal("the due timer wait was not resumed")
	}
	cancelled, event, err := repository.Cancel(ctx, run.ID, &seeded.userID, seeded.now.Add(11*time.Minute), nil)
	if err != nil || cancelled.Status != RunCancelled || event.Type != "workflow.run.cancelled" {
		t.Fatalf("Cancel() = %+v, %+v, %v", cancelled, event, err)
	}
}

// An event whose workspace was deleted after the fact still gets its receipt
// (with a null workspace) instead of a foreign-key failure that would abort
// the claim and leave the whole batch unreceipted on every tick.
func TestReceiptSurvivesAnEventWhoseWorkspaceIsGone(t *testing.T) {
	ctx := context.Background()
	repository, seeded := seed(t, ctx)
	topic := "test.orphan." + uuid.NewString()[:8]
	t.Cleanup(func() {
		_, _ = seeded.pool.Exec(context.Background(), `DELETE FROM outbox_events WHERE topic = $1`, topic)
	})
	orphanEvent, goneWorkspace := uuid.New(), uuid.New()
	liveEvent := uuid.New()
	for _, row := range []struct {
		id, workspace uuid.UUID
		at            time.Time
	}{{orphanEvent, goneWorkspace, seeded.now}, {liveEvent, seeded.workspaceID, seeded.now.Add(time.Second)}} {
		if _, err := seeded.pool.Exec(ctx,
			`INSERT INTO outbox_events (id, topic, aggregate_type, aggregate_id, workspace_id, payload, occurred_at, available_at)
			 VALUES ($1, $2, 'issue', $3, $4, '{}'::jsonb, $5, $5)`,
			row.id, topic, uuid.New(), row.workspace, row.at); err != nil {
			t.Fatalf("seed outbox event: %v", err)
		}
	}
	claimed, err := repository.ClaimTriggerBatch(ctx, ClaimParams{Topics: []string{topic}, Limit: 10, Now: seeded.now.Add(time.Hour)},
		func(ctx context.Context, batch *TriggerBatch) error {
			for _, event := range batch.Events() {
				if err := batch.WriteReceipt(ctx, event.ID, event.WorkspaceID, ReceiptUnmatched, 0, "", seeded.now); err != nil {
					return err
				}
			}
			return nil
		})
	if err != nil || claimed != 2 {
		t.Fatalf("ClaimTriggerBatch() = %d, %v; want both events claimed and receipted", claimed, err)
	}
	var orphanWorkspace, liveWorkspace *uuid.UUID
	if err := seeded.pool.QueryRow(ctx, `SELECT workspace_id FROM automation_trigger_receipts WHERE event_id = $1`, orphanEvent).Scan(&orphanWorkspace); err != nil {
		t.Fatalf("orphan receipt missing: %v", err)
	}
	if err := seeded.pool.QueryRow(ctx, `SELECT workspace_id FROM automation_trigger_receipts WHERE event_id = $1`, liveEvent).Scan(&liveWorkspace); err != nil {
		t.Fatalf("live receipt missing: %v", err)
	}
	if orphanWorkspace != nil || liveWorkspace == nil || *liveWorkspace != seeded.workspaceID {
		t.Fatalf("receipt workspaces = %v, %v; want null for the orphan and the workspace for the live event", orphanWorkspace, liveWorkspace)
	}
}
