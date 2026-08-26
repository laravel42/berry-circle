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

// Canceller tells the executor that a run row was cancelled, so an
// orchestration parked on a wait stops waiting. The in-process starter needs
// no such call: its next step refuses a terminal run on its own.
type Canceller interface {
	Cancel(ctx context.Context, runID uuid.UUID) error
}

// ScheduleSpec is what a schedule trigger asks the scheduler to fire on.
type ScheduleSpec struct {
	Cron     string
	Timezone string
}

// Schedules is the seam through which activating, pausing and archiving a
// schedule-triggered workflow reaches whatever fires it: Temporal Schedules
// when the orchestration is enabled (orchestration.AutomationSchedules),
// the in-process scheduler otherwise (InProcessSchedules). NoopSchedules
// records nothing, for deployments that do not execute workflows.
type Schedules interface {
	Ensure(ctx context.Context, automationID uuid.UUID, spec ScheduleSpec) error
	Pause(ctx context.Context, automationID uuid.UUID) error
	Delete(ctx context.Context, automationID uuid.UUID) error
}

// NoopSchedules is the seam's stand-in until a scheduler exists.
type NoopSchedules struct{}

// Ensure records nothing.
func (NoopSchedules) Ensure(context.Context, uuid.UUID, ScheduleSpec) error { return nil }

// Pause records nothing.
func (NoopSchedules) Pause(context.Context, uuid.UUID) error { return nil }

// Delete records nothing.
func (NoopSchedules) Delete(context.Context, uuid.UUID) error { return nil }

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
	starter := &InProcessStarter{runner: runner, pool: pool}
	// Child runs a subworkflow step creates go on the same pool.
	runner.SetSubrunStarter(starter)
	return starter, nil
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
