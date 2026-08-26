// Package triggerdispatch is the second outbox consumer: it turns committed
// Berry facts into workflow runs, resumes runs that waited on those facts,
// releases issues whose blockers finished, and moves goals along as their
// work does.
//
// Every claimed event gets exactly one receipt and is never offered again
// (a receipt is the never-retry rule made durable): what an event starts is
// a paid call or a side effect, so a loop must not repeat it. Handling
// errors are recorded on the receipt and surfaced through logs and metrics.
// Only a failure to commit the claim itself leaves the events unreceipted,
// and that claim carries no side effect yet.
package triggerdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// DefaultMaxTickAge is how stale the last successful tick may be before
// /readyz reports the dispatcher unhealthy.
const DefaultMaxTickAge = 60 * time.Second

// Store is the automation persistence the dispatcher drives.
type Store interface {
	ClaimTriggerBatch(context.Context, automationrepo.ClaimParams, func(context.Context, *automationrepo.TriggerBatch) error) (int, error)
	ListWaitingOn(context.Context, string) ([]automationrepo.Run, error)
	GetRunWithSteps(context.Context, uuid.UUID) (automationrepo.Run, []automationrepo.StepRun, error)
	GetVersion(context.Context, uuid.UUID, int) (automationrepo.Version, error)
	ClaimResumableIn(context.Context, *uuid.UUID, time.Time, int, func() uuid.UUID) ([]automationrepo.Run, []automationrepo.Event, error)
	CountOpenRunsForGoal(context.Context, uuid.UUID) (int, error)
	OldestUnreceipted(context.Context, []string) (*time.Time, error)
}

// IssueStore releases dependents when their blocker finishes.
type IssueStore interface {
	ReleaseDependents(context.Context, uuid.UUID, time.Time, func() uuid.UUID) (core.DependencyRelease, error)
}

// GoalStore moves goals with their issues.
type GoalStore interface {
	GoalForIssue(context.Context, uuid.UUID) (uuid.UUID, error)
	Get(context.Context, uuid.UUID) (goals.Goal, error)
	Progress(context.Context, uuid.UUID) (goals.Progress, error)
	Transition(context.Context, uuid.UUID, goals.Status, *uuid.UUID, time.Time, func() uuid.UUID) (goals.Goal, goals.Event, error)
}

// Options are explicit dependencies. Issues and Goals are optional: without
// them the dispatcher only starts and resumes runs.
type Options struct {
	Store       Store
	Issues      IssueStore
	Goals       GoalStore
	Starter     automationrun.Starter
	Broadcaster realtime.Broadcaster
	Clock       func() time.Time
	NewID       func() uuid.UUID
	Logger      *slog.Logger
	Metrics     *observability.AutomationMetrics
	// Health receives every successful tick; nil disables the probe.
	Health *Health
	// Topics overrides the outbox topics scanned; nil selects every Berry
	// event topic a workflow can subscribe to.
	Topics []string
	// WorkspaceID narrows claims to one workspace. Nil, the production
	// setting, serves every workspace; tests use it to keep a shared
	// database's events apart.
	WorkspaceID *uuid.UUID
}

// Dispatcher consumes the outbox for workflows. It is safe to run on every
// replica: claims skip locked rows and receipts are unique per event.
type Dispatcher struct {
	options Options
}

// Result is what one tick did.
type Result struct {
	Events   int
	Started  int
	Resumed  int
	Released int
	Timers   int
}

// New validates the required dependencies.
func New(options Options) (*Dispatcher, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("trigger dispatcher store is nil")
	case options.Starter == nil:
		return nil, errors.New("trigger dispatcher starter is nil")
	case options.Clock == nil:
		return nil, errors.New("trigger dispatcher clock is nil")
	case options.NewID == nil:
		return nil, errors.New("trigger dispatcher ID generator is nil")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if len(options.Topics) == 0 {
		options.Topics = append([]string(nil), automation.BerryEventTopics...)
	}
	return &Dispatcher{options: options}, nil
}

// Run polls until the context ends. A tick that fails is logged and the
// next one tries again: the outbox and the receipts, not this loop, are the
// source of truth, and a transient database error must not stop every
// workflow in the deployment.
func (dispatcher *Dispatcher) Run(ctx context.Context, pollInterval time.Duration, batchSize int) error {
	if pollInterval <= 0 || batchSize < 1 || batchSize > 500 {
		return errors.New("invalid trigger dispatcher run options")
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		result, err := dispatcher.RunOnce(ctx, batchSize)
		delay := pollInterval
		switch {
		case errors.Is(err, context.Canceled):
			return err
		case err != nil:
			dispatcher.options.Logger.Error("trigger dispatcher tick failed", "error", err)
		case result.Events == batchSize:
			delay = 0
		}
		timer.Reset(delay)
	}
}

// Check reports whether the dispatcher ticked recently. It is the /readyz
// probe when a Health was configured.
func (dispatcher *Dispatcher) Check(ctx context.Context) error {
	if dispatcher.options.Health == nil {
		return nil
	}
	return dispatcher.options.Health.Check(ctx)
}

// deferred is the work that must wait for the claim to commit: a run is
// only visible to a worker once its row is.
type deferred struct {
	start  *uuid.UUID
	resume *uuid.UUID
	signal automationrun.ResumeSignal
}

// RunOnce resumes elapsed timers, then claims one batch of events and
// handles each: match, resume, release, goal progress, receipt.
func (dispatcher *Dispatcher) RunOnce(ctx context.Context, limit int) (Result, error) {
	if limit < 1 || limit > 500 {
		return Result{}, errors.New("trigger dispatcher batch size is invalid")
	}
	now := dispatcher.now()
	result := Result{}
	timers, err := dispatcher.resumeTimers(ctx, now, limit)
	if err != nil {
		return result, err
	}
	result.Timers = timers

	var work []deferred
	count, err := dispatcher.options.Store.ClaimTriggerBatch(ctx, automationrepo.ClaimParams{
		Topics: dispatcher.options.Topics, Limit: limit, Now: now, WorkspaceID: dispatcher.options.WorkspaceID,
	}, func(ctx context.Context, batch *automationrepo.TriggerBatch) error {
		for _, event := range batch.Events() {
			handled, err := dispatcher.handle(ctx, batch, event, now)
			if err != nil {
				// A database failure inside the claim aborts the transaction;
				// the receipts roll back and the next tick claims again. No
				// side effect has been started for these events yet.
				return err
			}
			if err := batch.WriteReceipt(ctx, event.ID, event.WorkspaceID, handled.outcome, handled.matched, handled.reason, now); err != nil {
				return err
			}
			dispatcher.options.Metrics.CountDispatch(string(handled.outcome))
			if handled.outcome == automationrepo.ReceiptFailed || handled.outcome == automationrepo.ReceiptSkipped {
				dispatcher.options.Logger.Warn("trigger event not fully handled",
					"eventId", event.ID, "topic", event.Topic, "outcome", handled.outcome, "reason", handled.reason)
			}
			result.Released += handled.released
			work = append(work, handled.work...)
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	result.Events = count
	for _, item := range work {
		switch {
		case item.start != nil:
			if err := dispatcher.options.Starter.Start(ctx, *item.start); err != nil {
				dispatcher.options.Logger.Error("workflow run not started", "runId", *item.start, "error", err)
				continue
			}
			result.Started++
		case item.resume != nil:
			if err := dispatcher.options.Starter.Resume(ctx, *item.resume, item.signal); err != nil {
				dispatcher.options.Logger.Warn("workflow run not resumed", "runId", *item.resume, "signal", item.signal.Key(), "error", err)
				continue
			}
			result.Resumed++
		}
	}
	dispatcher.observeLag(ctx, now)
	if dispatcher.options.Health != nil {
		dispatcher.options.Health.MarkTick(now)
	}
	return result, nil
}

// resumeTimers returns elapsed timer waits to running and continues them.
func (dispatcher *Dispatcher) resumeTimers(ctx context.Context, now time.Time, limit int) (int, error) {
	runs, events, err := dispatcher.options.Store.ClaimResumableIn(ctx, dispatcher.options.WorkspaceID, now, limit, dispatcher.options.NewID)
	if err != nil {
		return 0, err
	}
	dispatcher.publish(ctx, events...)
	resumed := 0
	for _, run := range runs {
		signal := automationrun.ResumeSignal{Kind: automationrun.SignalTimer, OccurredAt: now}
		if err := dispatcher.options.Starter.Resume(ctx, run.ID, signal); err != nil {
			dispatcher.options.Logger.Warn("workflow timer not resumed", "runId", run.ID, "error", err)
			continue
		}
		resumed++
	}
	return resumed, nil
}

type handled struct {
	outcome  automationrepo.ReceiptOutcome
	matched  int
	reason   string
	released int
	work     []deferred
}

// handle processes one claimed event. It returns an error only for database
// failures that abort the claim; everything else becomes the receipt.
func (dispatcher *Dispatcher) handle(
	ctx context.Context,
	batch *automationrepo.TriggerBatch,
	event automationrepo.TriggerEvent,
	now time.Time,
) (handled, error) {
	if event.WorkspaceID == nil || *event.WorkspaceID == uuid.Nil {
		return handled{outcome: automationrepo.ReceiptSkipped, reason: "event has no workspace"}, nil
	}
	workspaceID := *event.WorkspaceID
	scope := triggerScope(event)
	var (
		result  handled
		reasons []string
		failed  bool
		acted   bool
	)

	// (a) Berry event triggers.
	items, err := batch.MatchActive(ctx, workspaceID, event.Topic)
	if err != nil {
		return handled{}, fmt.Errorf("match automations for %s: %w", event.ID, err)
	}
	payload, err := json.Marshal(scope)
	if err != nil {
		return handled{outcome: automationrepo.ReceiptFailed, reason: "event payload cannot be encoded"}, nil
	}
	for _, item := range items {
		definition, findings := automation.ParseDefinition(item.Definition)
		if len(findings) > 0 {
			reasons = append(reasons, "workflow "+item.ID.String()+": definition does not parse")
			failed = true
			continue
		}
		if definition.Trigger.Config != nil && definition.Trigger.Config.Filter != nil {
			pass, err := automation.Evaluate(*definition.Trigger.Config.Filter, automation.Scope{"trigger": scope})
			if err != nil {
				reasons = append(reasons, "workflow "+item.ID.String()+": filter "+err.Error())
				failed = true
				continue
			}
			if !pass {
				continue
			}
		}
		key := event.ID.String()
		run, created, err := batch.CreateRun(ctx, automationrepo.CreateRunParams{
			ID: dispatcher.options.NewID(), AutomationID: item.ID, TriggerType: automation.TriggerBerryEvent,
			Payload: payload, SourceEventKey: &key, RequestedBy: item.CreatedBy,
			RequestID: "trigger:" + event.ID.String(), CreatedAt: now,
		})
		if errors.Is(err, automationrepo.ErrNotActive) {
			continue
		}
		if err != nil {
			return handled{}, fmt.Errorf("create run for %s: %w", event.ID, err)
		}
		result.matched++
		acted = true
		if created {
			runID := run.ID
			result.work = append(result.work, deferred{start: &runID})
		}
	}

	// (b) Runs waiting on this fact.
	inner := innerPayload(event.Payload)
	for _, signal := range automationrun.WaitKeys(event.Topic, event.AggregateID, inner, event.OccurredAt) {
		keys := []string{signal.Key()}
		if signal.Kind == automationrun.SignalEvent {
			if aggregate, _, ok := strings.Cut(event.Topic, "."); ok {
				keys = append(keys, "event:"+aggregate+".*")
			}
		}
		for _, key := range keys {
			waiting, err := dispatcher.options.Store.ListWaitingOn(ctx, key)
			if err != nil {
				return handled{}, fmt.Errorf("list runs waiting on %s: %w", key, err)
			}
			for _, run := range waiting {
				if run.WorkspaceID != workspaceID {
					continue
				}
				if signal.Kind == automationrun.SignalEvent {
					pass, err := dispatcher.eventFilterPasses(ctx, run, scope)
					if err != nil {
						reasons = append(reasons, "run "+run.ID.String()+": "+err.Error())
						failed = true
						continue
					}
					if !pass {
						continue
					}
				}
				runID := run.ID
				resumeSignal := signal
				result.matched++
				acted = true
				result.work = append(result.work, deferred{resume: &runID, signal: resumeSignal})
			}
		}
	}

	// (c) Dependency release.
	if dispatcher.options.Issues != nil && (event.Topic == "issue.completed" || event.Topic == "issue.deleted") {
		release, err := dispatcher.options.Issues.ReleaseDependents(ctx, event.AggregateID, now, dispatcher.options.NewID)
		if err != nil {
			reasons = append(reasons, "dependency release: "+err.Error())
			failed = true
		}
		if len(release.Released) > 0 {
			acted = true
			result.released += len(release.Released)
			dispatcher.publishIssues(ctx, release.Released)
		}
		for _, gated := range release.Gated {
			reasons = append(reasons, "dependent "+gated.String()+" stays blocked: approval required")
		}
	}

	// (d) Goal progress.
	if dispatcher.options.Goals != nil && strings.HasPrefix(event.Topic, "issue.") {
		moved, err := dispatcher.advanceGoal(ctx, event.Topic, event.AggregateID, now)
		if err != nil {
			reasons = append(reasons, "goal progress: "+err.Error())
			failed = true
		}
		acted = acted || moved
	}

	result.reason = strings.Join(reasons, "; ")
	switch {
	case failed:
		result.outcome = automationrepo.ReceiptFailed
	case acted:
		result.outcome = automationrepo.ReceiptMatched
	case len(reasons) > 0:
		result.outcome = automationrepo.ReceiptSkipped
	default:
		result.outcome = automationrepo.ReceiptUnmatched
	}
	return result, nil
}

// eventFilterPasses evaluates the waiting step's event filter. The filter
// reads the incoming event as item, beside the run's own trigger and step
// outputs.
func (dispatcher *Dispatcher) eventFilterPasses(ctx context.Context, run automationrepo.Run, event map[string]any) (bool, error) {
	_, steps, err := dispatcher.options.Store.GetRunWithSteps(ctx, run.ID)
	if err != nil {
		return false, err
	}
	var waitingStep *automationrepo.StepRun
	for index := range steps {
		if steps[index].Status == automationrepo.StepWaiting {
			waitingStep = &steps[index]
		}
	}
	if waitingStep == nil {
		return false, errors.New("no waiting step")
	}
	version, err := dispatcher.options.Store.GetVersion(ctx, run.AutomationID, run.AutomationVersion)
	if err != nil {
		return false, err
	}
	definition, findings := automation.ParseDefinition(version.Definition)
	if len(findings) > 0 {
		return false, errors.New("definition does not parse")
	}
	for _, step := range definition.Steps {
		if step.ID != waitingStep.StepID {
			continue
		}
		if step.Type != automation.StepWait || step.Wait == nil || step.Wait.Event == nil || step.Wait.Event.Filter == nil {
			return true, nil
		}
		scope := automation.Scope{"trigger": rawObject(run.TriggerPayload), "steps": map[string]any{}, "item": event}
		outputs := scope["steps"].(map[string]any)
		for _, row := range steps {
			if row.Status == automationrepo.StepSucceeded {
				outputs[row.StepID] = map[string]any{"output": rawValue(row.Output)}
			}
		}
		return automation.Evaluate(*step.Wait.Event.Filter, scope)
	}
	return true, nil
}

// advanceGoal starts a goal when its first issue starts and completes it
// when every issue is done or cancelled and no workflow of its own is still
// running. It reports whether the goal moved.
func (dispatcher *Dispatcher) advanceGoal(ctx context.Context, topic string, issueID uuid.UUID, now time.Time) (bool, error) {
	switch topic {
	case "issue.started", "issue.completed", "issue.deleted", "issue.updated":
	default:
		return false, nil
	}
	goalID, err := dispatcher.options.Goals.GoalForIssue(ctx, issueID)
	if errors.Is(err, goals.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	goal, err := dispatcher.options.Goals.Get(ctx, goalID)
	if err != nil {
		return false, err
	}
	if goal.Status.Terminal() {
		return false, nil
	}
	if topic == "issue.started" {
		if goal.Status != goals.StatusDraft && goal.Status != goals.StatusPlanned {
			return false, nil
		}
		return dispatcher.transitionGoal(ctx, goal.ID, goals.StatusActive, now)
	}
	progress, err := dispatcher.options.Goals.Progress(ctx, goalID)
	if err != nil {
		return false, err
	}
	if progress.IssuesTotal == 0 || progress.IssuesDone+progress.IssuesCancelled < progress.IssuesTotal {
		return false, nil
	}
	open, err := dispatcher.options.Store.CountOpenRunsForGoal(ctx, goalID)
	if err != nil {
		return false, err
	}
	if open > 0 {
		return false, nil
	}
	moved := false
	if goal.Status == goals.StatusDraft || goal.Status == goals.StatusPlanned {
		// A goal whose work finished without ever starting still completes;
		// the lifecycle only knows completion from active.
		started, err := dispatcher.transitionGoal(ctx, goal.ID, goals.StatusActive, now)
		if err != nil {
			return false, err
		}
		moved = started
	}
	completed, err := dispatcher.transitionGoal(ctx, goal.ID, goals.StatusCompleted, now.Add(time.Microsecond))
	return moved || completed, err
}

func (dispatcher *Dispatcher) transitionGoal(ctx context.Context, goalID uuid.UUID, to goals.Status, now time.Time) (bool, error) {
	_, event, err := dispatcher.options.Goals.Transition(ctx, goalID, to, nil, now, dispatcher.options.NewID)
	if err != nil {
		if errors.Is(err, goals.ErrInvalidTransition) {
			return false, nil
		}
		return false, err
	}
	if event.ID == uuid.Nil {
		return false, nil
	}
	dispatcher.publish(ctx, event)
	return true, nil
}

func (dispatcher *Dispatcher) observeLag(ctx context.Context, now time.Time) {
	if dispatcher.options.Metrics == nil {
		return
	}
	oldest, err := dispatcher.options.Store.OldestUnreceipted(ctx, dispatcher.options.Topics)
	if err != nil {
		return
	}
	if oldest == nil {
		dispatcher.options.Metrics.ObserveDispatchLag(0)
		return
	}
	dispatcher.options.Metrics.ObserveDispatchLag(now.Sub(*oldest))
}

func (dispatcher *Dispatcher) now() time.Time {
	return dispatcher.options.Clock().UTC()
}

// triggerScope is what a trigger filter and a run's templates read: the
// fact's own payload at the top level, with the envelope's identity beside
// it. issue.completed therefore exposes trigger.issue.identifier and
// trigger.topic alike.
func triggerScope(event automationrepo.TriggerEvent) map[string]any {
	scope := rawObject(innerPayload(event.Payload))
	set := func(key string, value any) {
		if _, present := scope[key]; !present {
			scope[key] = value
		}
	}
	set("topic", event.Topic)
	set("eventId", event.ID.String())
	set("occurredAt", event.OccurredAt.UTC().Format(time.RFC3339Nano))
	set("aggregateType", event.AggregateType)
	set("aggregateId", event.AggregateID.String())
	if event.WorkspaceID != nil {
		set("workspaceId", event.WorkspaceID.String())
	}
	if event.BoardID != nil {
		set("boardId", event.BoardID.String())
	}
	return scope
}

// innerPayload unwraps the stored envelope to the fact's payload; a row that
// is not an envelope is returned as it is.
func innerPayload(stored json.RawMessage) json.RawMessage {
	decoded, err := ledger.DecodeEnvelope(stored)
	if err != nil {
		return stored
	}
	return decoded.Payload
}

func rawObject(raw json.RawMessage) map[string]any {
	var decoded map[string]any
	if len(raw) == 0 || json.Unmarshal(raw, &decoded) != nil || decoded == nil {
		return map[string]any{}
	}
	return decoded
}

func rawValue(raw json.RawMessage) any {
	var decoded any
	if len(raw) == 0 || json.Unmarshal(raw, &decoded) != nil {
		return nil
	}
	return decoded
}

func (dispatcher *Dispatcher) publish(ctx context.Context, events ...ledger.Event) {
	if dispatcher.options.Broadcaster == nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, event := range events {
		if event.ID == uuid.Nil {
			continue
		}
		boardID := ""
		if event.BoardID != uuid.Nil {
			boardID = event.BoardID.String()
		}
		_ = dispatcher.options.Broadcaster.Publish(publishCtx, realtime.Event{
			ID: event.ID.String(), WorkspaceID: event.WorkspaceID.String(), BoardID: boardID,
			Type: event.Type, Payload: event.Payload, OccurredAt: event.OccurredAt,
		})
	}
}

func (dispatcher *Dispatcher) publishIssues(ctx context.Context, events []core.IssueMutationEvent) {
	converted := make([]ledger.Event, 0, len(events))
	for _, event := range events {
		converted = append(converted, ledger.Event{
			ID: event.ID, Type: event.Type, OccurredAt: event.OccurredAt, WorkspaceID: event.WorkspaceID,
			BoardID: event.BoardID, IssueID: event.IssueID, Payload: event.Payload,
		})
	}
	dispatcher.publish(ctx, converted...)
}

// Health remembers the last successful tick so /readyz can tell a stalled
// dispatcher from a healthy one. It is created before the dispatcher so the
// probe can be registered at boot and filled in later.
type Health struct {
	maxAge time.Duration
	last   atomic.Int64
	clock  func() time.Time
}

// NewHealth builds a probe that passes until a tick is older than maxAge.
// It starts fresh at construction so a booting process is not reported
// stalled before its first tick.
func NewHealth(maxAge time.Duration, clock func() time.Time) *Health {
	if maxAge <= 0 {
		maxAge = DefaultMaxTickAge
	}
	if clock == nil {
		clock = time.Now
	}
	health := &Health{maxAge: maxAge, clock: clock}
	health.MarkTick(clock())
	return health
}

// MarkTick records a successful tick.
func (health *Health) MarkTick(at time.Time) {
	if health == nil {
		return
	}
	health.last.Store(at.UnixNano())
}

// Check fails when the last tick is older than the allowed age.
func (health *Health) Check(context.Context) error {
	if health == nil {
		return nil
	}
	last := time.Unix(0, health.last.Load())
	if age := health.clock().Sub(last); age > health.maxAge {
		return fmt.Errorf("trigger dispatcher last ticked %s ago", age.Round(time.Second))
	}
	return nil
}
