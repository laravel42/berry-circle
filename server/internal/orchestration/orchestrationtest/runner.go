package orchestrationtest

import (
	"context"
	"sync"

	"github.com/google/uuid"

	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// Runner is an in-memory orchestration.AutomationRunner and
// AutomationRunReader whose runs finish as soon as they execute, for tests
// that need the Temporal path without a database or a definition.
type Runner struct {
	mu       sync.Mutex
	runs     map[uuid.UUID]*automationrepo.Run
	executed []uuid.UUID
	resumed  []uuid.UUID
}

// NewRunner builds an empty runner.
func NewRunner() *Runner {
	return &Runner{runs: map[uuid.UUID]*automationrepo.Run{}}
}

// Execute completes the run.
func (runner *Runner) Execute(_ context.Context, runID uuid.UUID) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.executed = append(runner.executed, runID)
	runner.run(runID).Status = automationrepo.RunSucceeded
}

// Resume completes the run.
func (runner *Runner) Resume(_ context.Context, runID uuid.UUID, _ automationrun.ResumeSignal) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	runner.resumed = append(runner.resumed, runID)
	run := runner.run(runID)
	run.Status = automationrepo.RunSucceeded
	run.WaitingOn = nil
}

// Fail records a failure unless the run already finished.
func (runner *Runner) Fail(_ context.Context, runID uuid.UUID, failure automationrepo.Failure) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	run := runner.run(runID)
	if run.Status.Terminal() {
		return automationrepo.ErrRunTerminal
	}
	run.Status = automationrepo.RunFailed
	run.Failure = &failure
	return nil
}

// GetRun reads a run the runner has seen.
func (runner *Runner) GetRun(_ context.Context, runID uuid.UUID) (automationrepo.Run, error) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	run, ok := runner.runs[runID]
	if !ok {
		return automationrepo.Run{}, automationrepo.ErrNotFound
	}
	return *run, nil
}

// Executed lists the runs Execute was called for, in order.
func (runner *Runner) Executed() []uuid.UUID {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	return append([]uuid.UUID(nil), runner.executed...)
}

func (runner *Runner) run(runID uuid.UUID) *automationrepo.Run {
	run, ok := runner.runs[runID]
	if !ok {
		run = &automationrepo.Run{ID: runID, Status: automationrepo.RunPending}
		runner.runs[runID] = run
	}
	return run
}
