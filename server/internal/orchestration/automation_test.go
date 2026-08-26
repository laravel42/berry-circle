package orchestration_test

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/orchestration/orchestrationtest"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// fakeRunner is a runner whose transitions the test scripts. It doubles as
// the run reader, the way the repository does in production.
type fakeRunner struct {
	mu       sync.Mutex
	runs     map[uuid.UUID]*automationrepo.Run
	executes int
	resumes  int
	failures []automationrepo.Failure
	// onExecute and onResume move the run the way the real runner would.
	onExecute func(run *automationrepo.Run)
	onResume  func(run *automationrepo.Run, signal automationrun.ResumeSignal)
}

func newFakeRunner(run automationrepo.Run) *fakeRunner {
	return &fakeRunner{runs: map[uuid.UUID]*automationrepo.Run{run.ID: &run}}
}

func (runner *fakeRunner) Execute(_ context.Context, runID uuid.UUID) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.executes++
	if run, ok := runner.runs[runID]; ok && runner.onExecute != nil && run.Status == automationrepo.RunPending {
		runner.onExecute(run)
	}
}

func (runner *fakeRunner) Resume(_ context.Context, runID uuid.UUID, signal automationrun.ResumeSignal) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.resumes++
	if run, ok := runner.runs[runID]; ok && runner.onResume != nil && run.Status == automationrepo.RunWaiting {
		runner.onResume(run, signal)
	}
}

func (runner *fakeRunner) Fail(_ context.Context, runID uuid.UUID, failure automationrepo.Failure) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	run, ok := runner.runs[runID]
	if !ok {
		return automationrepo.ErrNotFound
	}
	if run.Status.Terminal() {
		return automationrepo.ErrRunTerminal
	}
	run.Status = automationrepo.RunFailed
	run.Failure = &failure
	runner.failures = append(runner.failures, failure)
	return nil
}

func (runner *fakeRunner) GetRun(_ context.Context, runID uuid.UUID) (automationrepo.Run, error) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	run, ok := runner.runs[runID]
	if !ok {
		return automationrepo.Run{}, automationrepo.ErrNotFound
	}
	return *run, nil
}

func (runner *fakeRunner) counts() (int, int) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return runner.executes, runner.resumes
}

func park(key string) func(*automationrepo.Run) {
	return func(run *automationrepo.Run) {
		run.Status = automationrepo.RunWaiting
		run.WaitingOn = &key
	}
}

func finish(run *automationrepo.Run, _ automationrun.ResumeSignal) {
	run.Status = automationrepo.RunSucceeded
	run.WaitingOn = nil
}

type harness struct {
	runner  *fakeRunner
	client  *orchestrationtest.Client
	starter *orchestration.AutomationStarter
	runID   uuid.UUID
}

func newHarness(t *testing.T, status automationrepo.RunStatus) harness {
	t.Helper()
	runID := uuid.New()
	runner := newFakeRunner(automationrepo.Run{ID: runID, Status: status})
	activities := &orchestration.Activities{
		Automations: runner, AutomationRuns: runner,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	client := orchestrationtest.NewClient(activities)
	t.Cleanup(client.Close)
	starter, err := orchestration.NewAutomationStarter(client, "berry-runs")
	if err != nil {
		t.Fatalf("NewAutomationStarter() error = %v", err)
	}
	return harness{runner: runner, client: client, starter: starter, runID: runID}
}

// The orchestration walks the run, parks with it, applies the resume signal
// through the runner on the worker, and completes when the run does.
func TestAutomationOrchestrationWaitsForTheResumeSignal(t *testing.T) {
	ctx := context.Background()
	approvalID := uuid.New()
	h := newHarness(t, automationrepo.RunPending)
	h.runner.onExecute = park("approval:" + approvalID.String())
	var applied automationrun.ResumeSignal
	h.runner.onResume = func(run *automationrepo.Run, signal automationrun.ResumeSignal) {
		applied = signal
		finish(run, signal)
	}

	if err := h.starter.Start(ctx, h.runID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	workflowID := orchestration.AutomationRunWorkflowID(h.runID)
	if executes, resumes := h.runner.counts(); executes != 1 || resumes != 0 || !h.client.Running(workflowID) {
		t.Fatalf("after start: executes=%d resumes=%d running=%v", executes, resumes, h.client.Running(workflowID))
	}

	signal := automationrun.ResumeSignal{Kind: automationrun.SignalApproval, ID: approvalID, Topic: "approval.approved", Outcome: "approved", Payload: []byte(`{"note":"ok"}`), OccurredAt: time.Now().UTC()}
	if err := h.starter.Resume(ctx, h.runID, signal); err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if err := h.client.Wait(workflowID); err != nil {
		t.Fatalf("orchestration error = %v", err)
	}
	if executes, resumes := h.runner.counts(); executes != 1 || resumes != 1 {
		t.Fatalf("after resume: executes=%d resumes=%d", executes, resumes)
	}
	if applied.Key() != signal.Key() || applied.Outcome != "approved" || string(applied.Payload) != `{"note":"ok"}` {
		t.Fatalf("applied signal = %+v, want %+v", applied, signal)
	}
	if h.client.Starts() != 1 {
		t.Fatalf("starts = %d, want the one orchestration", h.client.Starts())
	}
}

// A cancel signal ends a parked orchestration without touching the runner:
// the route that sent it already cancelled the row.
func TestAutomationOrchestrationStopsWaitingOnCancel(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, automationrepo.RunPending)
	h.runner.onExecute = park("timer")
	if err := h.starter.Start(ctx, h.runID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if err := h.starter.Cancel(ctx, h.runID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	workflowID := orchestration.AutomationRunWorkflowID(h.runID)
	if err := h.client.Wait(workflowID); err != nil {
		t.Fatalf("orchestration error = %v", err)
	}
	if executes, resumes := h.runner.counts(); executes != 1 || resumes != 0 || len(h.runner.failures) != 0 {
		t.Fatalf("after cancel: executes=%d resumes=%d failures=%v", executes, resumes, h.runner.failures)
	}
}

// A run the runner left running — the walk stopped between steps — is
// recorded as failed rather than waited on forever, and the step activity
// is never retried: exactly one execute.
func TestAutomationOrchestrationRecordsAStalledRun(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, automationrepo.RunPending)
	h.runner.onExecute = func(run *automationrepo.Run) { run.Status = automationrepo.RunRunning }
	if err := h.starter.Start(ctx, h.runID); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	workflowID := orchestration.AutomationRunWorkflowID(h.runID)
	err := h.client.Wait(workflowID)
	if err == nil || !strings.Contains(err.Error(), "stopped without parking") {
		t.Fatalf("orchestration error = %v, want the stall", err)
	}
	if executes, _ := h.runner.counts(); executes != 1 {
		t.Fatalf("executes = %d, want exactly one: a stalled walk is never retried", executes)
	}
	if len(h.runner.failures) != 1 || h.runner.failures[0].Code != "ORCHESTRATION_FAILED" {
		t.Fatalf("failures = %+v, want ORCHESTRATION_FAILED", h.runner.failures)
	}
	if run, _ := h.runner.GetRun(ctx, h.runID); run.Status != automationrepo.RunFailed {
		t.Fatalf("run = %+v, want failed", run)
	}
}

// Two starts for one run — two dispatcher replicas, or a retried route —
// produce one orchestration and one walk, and both callers see success.
func TestAutomationStarterDedupesConcurrentStarts(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, automationrepo.RunPending)
	h.runner.onExecute = park("approval:" + uuid.NewString())
	var wait sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			errs <- h.starter.Start(ctx, h.runID)
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("Start() error = %v", err)
		}
	}
	if executes, _ := h.runner.counts(); executes != 1 || h.client.Starts() != 1 {
		t.Fatalf("executes = %d, starts = %d, want one each", executes, h.client.Starts())
	}
}

// A resume for a run with no orchestration — parked in-process before
// Temporal was enabled — starts one, which reads the rows and applies the
// signal instead of walking the run again.
func TestAutomationStarterResumeStartsAMissingOrchestration(t *testing.T) {
	ctx := context.Background()
	issueID := uuid.New()
	h := newHarness(t, automationrepo.RunWaiting)
	key := "issue:" + issueID.String()
	h.runner.runs[h.runID].WaitingOn = &key
	h.runner.onResume = finish
	signal := automationrun.ResumeSignal{Kind: automationrun.SignalIssue, ID: issueID, Topic: "issue.completed", Outcome: "completed", OccurredAt: time.Now()}
	if err := h.starter.Resume(ctx, h.runID, signal); err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	workflowID := orchestration.AutomationRunWorkflowID(h.runID)
	if err := h.client.Wait(workflowID); err != nil {
		t.Fatalf("orchestration error = %v", err)
	}
	if executes, resumes := h.runner.counts(); executes != 1 || resumes != 1 || h.client.Starts() != 1 {
		t.Fatalf("executes=%d resumes=%d starts=%d", executes, resumes, h.client.Starts())
	}
	if run, _ := h.runner.GetRun(ctx, h.runID); run.Status != automationrepo.RunSucceeded {
		t.Fatalf("run = %+v, want succeeded", run)
	}
}

// Cancelling a run whose orchestration already finished (or never existed)
// is not an error: the row is what was cancelled.
func TestAutomationStarterCancelIgnoresAMissingOrchestration(t *testing.T) {
	h := newHarness(t, automationrepo.RunPending)
	if err := h.starter.Cancel(context.Background(), uuid.New()); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if err := h.starter.Cancel(context.Background(), uuid.Nil); err == nil {
		t.Fatal("Cancel(nil) should refuse")
	}
}

// The wire payload round-trips every signal kind the runner knows and
// refuses what it does not.
func TestAutomationActivitiesConvertSignals(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, automationrepo.RunWaiting)
	activities := &orchestration.Activities{Automations: h.runner, AutomationRuns: h.runner}
	var applied []automationrun.ResumeSignal
	h.runner.onResume = func(_ *automationrepo.Run, signal automationrun.ResumeSignal) { applied = append(applied, signal) }
	id := uuid.New()
	for _, signal := range []automationrun.ResumeSignal{
		{Kind: automationrun.SignalApproval, ID: id, Outcome: "rejected"},
		{Kind: automationrun.SignalRun, ID: id, Outcome: "completed"},
		{Kind: automationrun.SignalEvent, ID: id, Topic: "issue.created", Outcome: "issue.created"},
		{Kind: automationrun.SignalTimer},
	} {
		if _, err := activities.ResumeAutomationRun(ctx, h.runID.String(), orchestration.ResumePayload(signal)); err != nil {
			t.Fatalf("ResumeAutomationRun(%s) error = %v", signal.Key(), err)
		}
	}
	if len(applied) != 4 {
		t.Fatalf("applied = %d signals, want 4", len(applied))
	}
	for index, want := range []string{"approval:" + id.String(), "run:" + id.String(), "event:issue.created", "timer"} {
		if applied[index].Key() != want {
			t.Fatalf("signal %d key = %q, want %q", index, applied[index].Key(), want)
		}
	}
	for _, bad := range []orchestration.AutomationResume{
		{Kind: "teleport"},
		{Kind: "approval", ID: "not-a-uuid"},
		{Kind: "event"},
	} {
		if _, err := activities.ResumeAutomationRun(ctx, h.runID.String(), bad); err == nil {
			t.Fatalf("ResumeAutomationRun(%+v) accepted an invalid signal", bad)
		}
	}
	if _, err := activities.ExecuteAutomationRun(ctx, "nope"); err == nil {
		t.Fatal("ExecuteAutomationRun accepted a malformed id")
	}
	if err := activities.FailAutomationRun(ctx, uuid.NewString(), "lost"); err != nil {
		t.Fatalf("FailAutomationRun on an unknown run = %v, want nil", err)
	}
}

// A schedule tick creates one run per fire time and none for a workflow
// that is no longer active.
func TestCreateScheduledRunIsIdempotentPerFireTime(t *testing.T) {
	ctx := context.Background()
	store := &fakeScheduledRuns{item: automationrepo.Automation{ID: uuid.New(), Status: automationrepo.StatusActive, Trigger: automationrepo.Trigger{Cron: "0 9 * * 1", Timezone: "Europe/Rome"}}}
	activities := &orchestration.Activities{ScheduledRuns: store, Clock: time.Now, NewID: uuid.New}
	fireTime := time.Date(2026, time.August, 31, 7, 0, 0, 0, time.UTC)
	first, err := activities.CreateScheduledRun(ctx, store.item.ID.String(), fireTime)
	if err != nil || first == "" {
		t.Fatalf("CreateScheduledRun() = %q, %v", first, err)
	}
	second, err := activities.CreateScheduledRun(ctx, store.item.ID.String(), fireTime)
	if err != nil || second != first {
		t.Fatalf("second CreateScheduledRun() = %q, %v, want %q", second, err, first)
	}
	if len(store.created) != 1 || store.created[0].SourceEventKey == nil ||
		*store.created[0].SourceEventKey != "schedule:"+store.item.ID.String()+":2026-08-31T07:00:00Z" {
		t.Fatalf("created = %+v", store.created)
	}
	store.item.Status = automationrepo.StatusPaused
	if id, err := activities.CreateScheduledRun(ctx, store.item.ID.String(), fireTime.Add(time.Hour)); err != nil || id != "" {
		t.Fatalf("paused CreateScheduledRun() = %q, %v, want no run", id, err)
	}
}

type fakeScheduledRuns struct {
	item    automationrepo.Automation
	created []automationrepo.CreateRunParams
}

func (store *fakeScheduledRuns) Get(_ context.Context, id uuid.UUID) (automationrepo.Automation, error) {
	if id != store.item.ID {
		return automationrepo.Automation{}, automationrepo.ErrNotFound
	}
	return store.item, nil
}

func (store *fakeScheduledRuns) CreateRun(_ context.Context, params automationrepo.CreateRunParams) (automationrepo.Run, bool, error) {
	if store.item.Status != automationrepo.StatusActive {
		return automationrepo.Run{}, false, automationrepo.ErrNotActive
	}
	for _, existing := range store.created {
		if existing.SourceEventKey != nil && params.SourceEventKey != nil && *existing.SourceEventKey == *params.SourceEventKey {
			return automationrepo.Run{ID: existing.ID}, false, nil
		}
	}
	store.created = append(store.created, params)
	return automationrepo.Run{ID: params.ID}, true, nil
}
