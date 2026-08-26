package automationrun

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/cron"
	"github.com/laravel42/berry-circle/server/internal/observability"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// ScheduleStore is the persistence the in-process scheduler drives.
type ScheduleStore interface {
	FireSchedules(context.Context, automationrepo.FireParams) ([]automationrepo.Run, error)
	SetScheduleNextAt(context.Context, uuid.UUID, *time.Time) error
	OldestDueSchedule(context.Context, time.Time, *uuid.UUID) (*time.Time, error)
}

// NextFire computes the fire time after an instant for a cron expression in
// a timezone; ok is false when the expression never fires again. It is the
// one place both the in-process scheduler and the schedule seam ask.
func NextFire(expression, timezone string, after time.Time) (time.Time, bool) {
	schedule, err := cron.Parse(expression)
	if err != nil {
		return time.Time{}, false
	}
	next, err := schedule.NextIn(after, timezone)
	if err != nil {
		return time.Time{}, false
	}
	return next, true
}

// InProcessSchedules is the Schedules seam without Temporal: activating a
// schedule-triggered workflow records its next fire time, which the
// Scheduler below claims when it passes; pausing or archiving clears it.
type InProcessSchedules struct {
	Store ScheduleStore
	Clock func() time.Time
}

// Ensure records the first fire time after now.
func (schedules InProcessSchedules) Ensure(ctx context.Context, automationID uuid.UUID, spec ScheduleSpec) error {
	if schedules.Store == nil || schedules.Clock == nil {
		return errors.New("in-process schedules are not configured")
	}
	next, ok := NextFire(spec.Cron, spec.Timezone, schedules.Clock().UTC())
	if !ok {
		return errors.New("the schedule never fires")
	}
	return schedules.Store.SetScheduleNextAt(ctx, automationID, &next)
}

// Pause withdraws the workflow from the scheduler.
func (schedules InProcessSchedules) Pause(ctx context.Context, automationID uuid.UUID) error {
	if schedules.Store == nil {
		return errors.New("in-process schedules are not configured")
	}
	return schedules.Store.SetScheduleNextAt(ctx, automationID, nil)
}

// Delete withdraws the workflow from the scheduler; an archived row is
// already out of the claim and is left alone.
func (schedules InProcessSchedules) Delete(ctx context.Context, automationID uuid.UUID) error {
	if schedules.Store == nil {
		return errors.New("in-process schedules are not configured")
	}
	err := schedules.Store.SetScheduleNextAt(ctx, automationID, nil)
	if errors.Is(err, automationrepo.ErrNotFound) {
		return nil
	}
	return err
}

var _ Schedules = InProcessSchedules{}

// SchedulerOptions are the in-process scheduler's explicit dependencies.
type SchedulerOptions struct {
	Store   ScheduleStore
	Starter Starter
	Clock   func() time.Time
	NewID   func() uuid.UUID
	Logger  *slog.Logger
	Metrics *observability.AutomationMetrics
	// CatchupWindow bounds how far behind a schedule may fall and still
	// fire its missed instants; zero selects the repository default.
	CatchupWindow time.Duration
	// WorkspaceID narrows the claim to one workspace; nil, the production
	// setting, serves every workspace.
	WorkspaceID *uuid.UUID
}

// Scheduler fires schedule triggers without Temporal. It ticks inside the
// trigger dispatcher's loop, claims due workflows with skip-locked rows so
// every replica may run it, creates one run per due instant (idempotent on
// the instant) and hands each to the starter. With Temporal enabled the
// Temporal Schedule does the same through CreateScheduledRun and this
// scheduler is not built.
type Scheduler struct {
	options SchedulerOptions
}

// NewScheduler validates the required dependencies.
func NewScheduler(options SchedulerOptions) (*Scheduler, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("automation scheduler store is nil")
	case options.Starter == nil:
		return nil, errors.New("automation scheduler starter is nil")
	case options.Clock == nil:
		return nil, errors.New("automation scheduler clock is nil")
	case options.NewID == nil:
		return nil, errors.New("automation scheduler ID generator is nil")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	return &Scheduler{options: options}, nil
}

// Tick fires every due schedule up to limit workflows and returns how many
// runs it created. A run whose handoff fails stays pending on the ledger
// and is logged; the instant is already consumed so it is never fired
// twice.
func (scheduler *Scheduler) Tick(ctx context.Context, limit int) (int, error) {
	if scheduler == nil {
		return 0, nil
	}
	now := scheduler.options.Clock().UTC()
	runs, err := scheduler.options.Store.FireSchedules(ctx, automationrepo.FireParams{
		Now: now, Limit: limit, WorkspaceID: scheduler.options.WorkspaceID, CatchupWindow: scheduler.options.CatchupWindow,
		NewID: scheduler.options.NewID, Next: NextFire,
	})
	if err != nil {
		return 0, err
	}
	started := 0
	for _, run := range runs {
		if err := scheduler.options.Starter.Start(ctx, run.ID); err != nil {
			scheduler.options.Logger.Error("scheduled workflow run not started", "runId", run.ID, "workflowId", run.AutomationID, "error", err)
			continue
		}
		started++
	}
	if scheduler.options.Metrics != nil {
		if oldest, err := scheduler.options.Store.OldestDueSchedule(ctx, now, scheduler.options.WorkspaceID); err == nil {
			lag := time.Duration(0)
			if oldest != nil {
				lag = now.Sub(*oldest)
			}
			scheduler.options.Metrics.ObserveScheduleLag(lag)
		}
	}
	return started, nil
}
