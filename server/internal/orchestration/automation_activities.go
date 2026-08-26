package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/activity"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// AutomationRunner executes workflow runs. Implemented by
// *automationrun.Runner, so Temporal and the in-process starter drive one
// implementation and cannot drift.
type AutomationRunner interface {
	Execute(context.Context, uuid.UUID)
	Resume(context.Context, uuid.UUID, automationrun.ResumeSignal)
	Fail(context.Context, uuid.UUID, automationrepo.Failure) error
}

// AutomationRunReader reads the run row back after the runner returns, which
// is how the orchestration learns whether the run finished or parked.
// Implemented by *automationrepo.Repository.
type AutomationRunReader interface {
	GetRun(context.Context, uuid.UUID) (automationrepo.Run, error)
}

// ScheduledRunStore creates the run a schedule tick fires. Implemented by
// *automationrepo.Repository. The Temporal Schedule that calls it lands with
// the schedule trigger (P4.5); the activity is the seam it will call.
type ScheduledRunStore interface {
	Get(context.Context, uuid.UUID) (automationrepo.Automation, error)
	CreateRun(context.Context, automationrepo.CreateRunParams) (automationrepo.Run, bool, error)
}

// ErrAutomationRunStalled means the runner returned with the run neither
// parked nor finished: it stopped between steps, which the orchestration
// turns into a recorded failure rather than an open-ended wait.
var ErrAutomationRunStalled = errors.New("automation run stopped without parking or finishing")

// ExecuteAutomationRun walks a run as far as it goes and reports where it
// stopped: parked on a wait key, or finished.
//
// THIS ACTIVITY MUST NEVER BE RETRIED. Every step the runner executes is
// recorded before the next one starts, and a step is a paid, unsafe call; a
// retry would not resume the walk, it would repeat the call the ledger has
// already recorded. The policy is pinned in automation.go and asserted in
// automation_policy_test.go.
func (activities *Activities) ExecuteAutomationRun(
	ctx context.Context,
	runID string,
) (AutomationRunState, error) {
	parsed, err := activities.automationRunID(runID)
	if err != nil {
		return AutomationRunState{}, err
	}
	stop := heartbeatWhile(ctx, AutomationHeartbeat/2, runID)
	defer stop()

	activities.Automations.Execute(ctx, parsed)
	return activities.automationState(ctx, parsed)
}

// ResumeAutomationRun settles the wait a signal answers and continues the
// walk. The same never-retry rule applies: the resumed step may itself be a
// paid call (an approved provider action runs here).
func (activities *Activities) ResumeAutomationRun(
	ctx context.Context,
	runID string,
	resume AutomationResume,
) (AutomationRunState, error) {
	parsed, err := activities.automationRunID(runID)
	if err != nil {
		return AutomationRunState{}, err
	}
	signal, err := resumeSignal(resume)
	if err != nil {
		return AutomationRunState{}, err
	}
	stop := heartbeatWhile(ctx, AutomationHeartbeat/2, runID)
	defer stop()

	activities.Automations.Resume(ctx, parsed, signal)
	return activities.automationState(ctx, parsed)
}

// FailAutomationRun records that the orchestration lost the run: the step
// activity timed out or its worker died. Safe to retry — a run that already
// finished is left alone.
func (activities *Activities) FailAutomationRun(
	ctx context.Context,
	runID string,
	reason string,
) error {
	parsed, err := activities.automationRunID(runID)
	if err != nil {
		return err
	}
	message := "The workflow orchestration could not finish the run"
	if reason != "" {
		message += ": " + reason
	}
	err = activities.Automations.Fail(ctx, parsed, automationrepo.Failure{
		Code:    "ORCHESTRATION_FAILED",
		Message: boundedMessage(message),
	})
	if errors.Is(err, automationrepo.ErrRunTerminal) || errors.Is(err, automationrepo.ErrNotFound) {
		return nil
	}
	return err
}

// CreateScheduledRun records the run one schedule tick fires and returns
// its id, or an empty id when the workflow is no longer active. Idempotent
// on the fire time: a Temporal Schedule that retries the action for the
// same instant finds the run it already created.
func (activities *Activities) CreateScheduledRun(
	ctx context.Context,
	automationID string,
	fireTime time.Time,
) (string, error) {
	if activities.ScheduledRuns == nil {
		return "", errors.New("scheduled run store is not configured")
	}
	parsed, err := uuid.Parse(automationID)
	if err != nil || parsed == uuid.Nil {
		return "", fmt.Errorf("scheduled run automation id: %w", err)
	}
	if fireTime.IsZero() {
		return "", errors.New("scheduled run fire time is required")
	}
	item, err := activities.ScheduledRuns.Get(ctx, parsed)
	if err != nil {
		if errors.Is(err, automationrepo.ErrNotFound) {
			return "", nil
		}
		return "", err
	}
	fired := fireTime.UTC().Format(time.RFC3339)
	payload, err := json.Marshal(map[string]any{"scheduledAt": fired, "cron": item.Trigger.Cron, "timezone": item.Trigger.Timezone})
	if err != nil {
		return "", err
	}
	clock, newID := activities.Clock, activities.NewID
	if clock == nil {
		clock = time.Now
	}
	if newID == nil {
		newID = uuid.New
	}
	key := "schedule:" + item.ID.String() + ":" + fired
	run, _, err := activities.ScheduledRuns.CreateRun(ctx, automationrepo.CreateRunParams{
		ID: newID(), AutomationID: item.ID, TriggerType: automation.TriggerSchedule,
		Payload: payload, SourceEventKey: &key, RequestedBy: item.CreatedBy,
		RequestID: key, CreatedAt: clock().UTC(),
	})
	if errors.Is(err, automationrepo.ErrNotActive) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return run.ID.String(), nil
}

func (activities *Activities) automationRunID(runID string) (uuid.UUID, error) {
	if activities.Automations == nil {
		return uuid.Nil, errors.New("automation runner is not configured")
	}
	parsed, err := uuid.Parse(runID)
	if err != nil || parsed == uuid.Nil {
		return uuid.Nil, fmt.Errorf("automation run id: %w", err)
	}
	return parsed, nil
}

// automationState reads the row the runner left behind. A run that neither
// parked nor finished stalled — the walk stopped between steps — and is
// reported as an error so the orchestration records it instead of waiting
// for a signal nothing will send.
func (activities *Activities) automationState(ctx context.Context, runID uuid.UUID) (AutomationRunState, error) {
	if activities.AutomationRuns == nil {
		return AutomationRunState{}, errors.New("automation run reader is not configured")
	}
	run, err := activities.AutomationRuns.GetRun(ctx, runID)
	if err != nil {
		return AutomationRunState{}, fmt.Errorf("read automation run: %w", err)
	}
	state := AutomationRunState{Status: string(run.Status), Terminal: run.Status.Terminal()}
	if run.WaitingOn != nil {
		state.WaitingOn = *run.WaitingOn
	}
	switch {
	case state.Terminal, run.Status == automationrepo.RunWaiting:
		return state, nil
	case ctx.Err() != nil:
		return state, ctx.Err()
	default:
		return state, fmt.Errorf("%w: %s", ErrAutomationRunStalled, run.Status)
	}
}

// resumeSignal converts the wire payload into the runner's vocabulary.
func resumeSignal(resume AutomationResume) (automationrun.ResumeSignal, error) {
	signal := automationrun.ResumeSignal{
		Kind: automationrun.SignalKind(resume.Kind), Topic: resume.Topic, Outcome: resume.Outcome,
		Payload: resume.Payload, OccurredAt: resume.OccurredAt,
	}
	switch signal.Kind {
	case automationrun.SignalApproval, automationrun.SignalRun, automationrun.SignalIssue:
		parsed, err := uuid.Parse(resume.ID)
		if err != nil || parsed == uuid.Nil {
			return automationrun.ResumeSignal{}, fmt.Errorf("automation resume id: %w", err)
		}
		signal.ID = parsed
	case automationrun.SignalEvent:
		if resume.ID != "" {
			signal.ID, _ = uuid.Parse(resume.ID)
		}
		if signal.Topic == "" {
			return automationrun.ResumeSignal{}, errors.New("automation resume topic is required")
		}
	case automationrun.SignalTimer:
	default:
		return automationrun.ResumeSignal{}, fmt.Errorf("automation resume kind %q is unknown", resume.Kind)
	}
	return signal, nil
}

// ResumePayload is the wire form of a runner signal, for the starter.
func ResumePayload(signal automationrun.ResumeSignal) AutomationResume {
	resume := AutomationResume{
		Kind: string(signal.Kind), Topic: signal.Topic, Outcome: signal.Outcome,
		Payload: signal.Payload, OccurredAt: signal.OccurredAt,
	}
	if signal.ID != uuid.Nil {
		resume.ID = signal.ID.String()
	}
	return resume
}

// heartbeatWhile reports liveness until stop is called, so a dead worker is
// detected as a heartbeat timeout rather than an orphaned row.
func heartbeatWhile(ctx context.Context, interval time.Duration, detail string) func() {
	beat, stop := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-beat.Done():
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx, detail)
			}
		}
	}()
	return stop
}

func boundedMessage(message string) string {
	const limit = 500
	if len(message) <= limit {
		return message
	}
	return message[:limit]
}
