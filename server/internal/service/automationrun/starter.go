package automationrun

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/service/runadmission"
)

// Starter is how a run gets executed: the in-process pool below, or the
// Temporal orchestration when it is enabled. Both drive the same Runner.
type Starter interface {
	// Start executes a pending run.
	Start(ctx context.Context, runID uuid.UUID) error
	// Resume settles what a waiting run waited on and continues it.
	Resume(ctx context.Context, runID uuid.UUID, signal ResumeSignal) error
}

// InProcessStarter executes runs on a bounded worker pool in this process.
// Like the issue run pool it wraps, queued work does not survive the
// process; the signal itself is applied to the rows before queueing so a
// restart finds the run already resumed and continues it on the next walk.
type InProcessStarter struct {
	runner *Runner
	pool   *runadmission.Pool
}

// NewInProcessStarter starts workers that call runner.Execute.
func NewInProcessStarter(ctx context.Context, runner *Runner, workers, queueSize int) (*InProcessStarter, error) {
	if runner == nil {
		return nil, errors.New("automation starter runner is nil")
	}
	pool, err := runadmission.NewPool(ctx, workers, queueSize, runner.Execute)
	if err != nil {
		return nil, err
	}
	return &InProcessStarter{runner: runner, pool: pool}, nil
}

// Start queues the run.
func (starter *InProcessStarter) Start(_ context.Context, runID uuid.UUID) error {
	if starter == nil {
		return errors.New("automation starter is not configured")
	}
	return starter.pool.Queue(runID)
}

// Resume applies the signal now, durably, and queues the continuation.
func (starter *InProcessStarter) Resume(ctx context.Context, runID uuid.UUID, signal ResumeSignal) error {
	if starter == nil {
		return errors.New("automation starter is not configured")
	}
	if err := starter.runner.ApplySignal(ctx, runID, signal); err != nil {
		return err
	}
	return starter.pool.Queue(runID)
}

// Close stops the workers and waits for in-flight steps.
func (starter *InProcessStarter) Close(ctx context.Context) error {
	if starter == nil {
		return nil
	}
	return starter.pool.Close(ctx)
}
