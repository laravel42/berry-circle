package orchestration_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// fakeScheduleStore is the store CreateScheduledRun writes.
type fakeScheduleStore struct {
	item    automationrepo.Automation
	created []automationrepo.CreateRunParams
}

func (store *fakeScheduleStore) Get(_ context.Context, id uuid.UUID) (automationrepo.Automation, error) {
	if id != store.item.ID {
		return automationrepo.Automation{}, automationrepo.ErrNotFound
	}
	return store.item, nil
}

func (store *fakeScheduleStore) CreateRun(_ context.Context, params automationrepo.CreateRunParams) (automationrepo.Run, bool, error) {
	if store.item.Status != automationrepo.StatusActive {
		return automationrepo.Run{}, false, automationrepo.ErrNotActive
	}
	for _, existing := range store.created {
		if *existing.SourceEventKey == *params.SourceEventKey {
			return automationrepo.Run{ID: existing.ID, AutomationID: store.item.ID}, false, nil
		}
	}
	store.created = append(store.created, params)
	return automationrepo.Run{ID: params.ID, AutomationID: store.item.ID, Status: automationrepo.RunPending}, true, nil
}

// One fire records exactly one run for the nominal instant with the same
// source key and payload the in-process scheduler writes, then starts the
// run orchestration as a child; an inactive workflow records nothing.
func TestAutomationScheduledRunCreatesTheRunForTheNominalInstant(t *testing.T) {
	creator := uuid.New()
	fireTime := time.Date(2026, time.March, 30, 7, 0, 0, 0, time.UTC)
	store := &fakeScheduleStore{item: automationrepo.Automation{
		ID: uuid.New(), WorkspaceID: uuid.New(), Status: automationrepo.StatusActive, Version: 2, CreatedBy: &creator,
		Trigger: automationrepo.Trigger{Type: automation.TriggerSchedule, Cron: "0 9 * * 1", Timezone: "Europe/Rome"},
	}}
	run := func(t *testing.T) *testsuite.TestWorkflowEnvironment {
		t.Helper()
		suite := &testsuite.WorkflowTestSuite{}
		env := suite.NewTestWorkflowEnvironment()
		env.RegisterWorkflowWithOptions(orchestration.AutomationScheduledRun, workflow.RegisterOptions{Name: orchestration.AutomationScheduledRunName})
		env.RegisterWorkflowWithOptions(orchestration.AutomationOrchestration, workflow.RegisterOptions{Name: orchestration.AutomationOrchestrationName})
		env.RegisterActivity(&orchestration.Activities{ScheduledRuns: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
		env.OnWorkflow(orchestration.AutomationOrchestrationName, mock.Anything, mock.Anything).Return(nil)
		if err := env.SetTypedSearchAttributesOnStart(temporal.NewSearchAttributes(temporal.NewSearchAttributeKeyTime("TemporalScheduledStartTime").ValueSet(fireTime))); err != nil {
			t.Fatalf("search attributes: %v", err)
		}
		env.ExecuteWorkflow(orchestration.AutomationScheduledRunName, store.item.ID.String())
		if !env.IsWorkflowCompleted() {
			t.Fatal("scheduled run did not complete")
		}
		if err := env.GetWorkflowError(); err != nil {
			t.Fatalf("scheduled run error = %v", err)
		}
		return env
	}
	env := run(t)
	if len(store.created) != 1 {
		t.Fatalf("runs created = %+v", store.created)
	}
	created := store.created[0]
	wantKey := automationrepo.ScheduleKey(store.item.ID, fireTime)
	if created.SourceEventKey == nil || *created.SourceEventKey != wantKey || created.TriggerType != automation.TriggerSchedule ||
		created.RequestedBy == nil || *created.RequestedBy != creator {
		t.Fatalf("created = %+v, want key %s", created, wantKey)
	}
	wantPayload, _ := automationrepo.SchedulePayload(fireTime, "0 9 * * 1", "Europe/Rome")
	if string(created.Payload) != string(wantPayload) {
		t.Fatalf("payload = %s, want %s", created.Payload, wantPayload)
	}
	env.AssertExpectations(t)

	// A retried fire for the same instant finds the run it already created.
	run(t)
	if len(store.created) != 1 {
		t.Fatalf("a retry created a second run: %+v", store.created)
	}

	store.item.Status = automationrepo.StatusPaused
	suite := &testsuite.WorkflowTestSuite{}
	env = suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflowWithOptions(orchestration.AutomationScheduledRun, workflow.RegisterOptions{Name: orchestration.AutomationScheduledRunName})
	env.RegisterWorkflowWithOptions(orchestration.AutomationOrchestration, workflow.RegisterOptions{Name: orchestration.AutomationOrchestrationName})
	env.RegisterActivity(&orchestration.Activities{ScheduledRuns: store, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	env.ExecuteWorkflow(orchestration.AutomationScheduledRunName, store.item.ID.String())
	if err := env.GetWorkflowError(); err != nil || len(store.created) != 1 {
		t.Fatalf("paused workflow: err = %v created = %+v", err, store.created)
	}
}

type fakeScheduleHandle struct {
	id      string
	options client.ScheduleOptions
	paused  bool
	deleted bool
	updates int
}

func (handle *fakeScheduleHandle) GetID() string { return handle.id }
func (handle *fakeScheduleHandle) Delete(context.Context) error {
	handle.deleted = true
	return nil
}
func (handle *fakeScheduleHandle) Backfill(context.Context, client.ScheduleBackfillOptions) error {
	return nil
}
func (handle *fakeScheduleHandle) Update(ctx context.Context, options client.ScheduleUpdateOptions) error {
	spec := handle.options.Spec
	description := client.ScheduleDescription{Schedule: client.Schedule{
		Action: handle.options.Action, Spec: &spec,
		Policy: &client.SchedulePolicies{Overlap: handle.options.Overlap, CatchupWindow: handle.options.CatchupWindow},
		State:  &client.ScheduleState{Paused: handle.paused},
	}}
	update, err := options.DoUpdate(client.ScheduleUpdateInput{Description: description})
	if err != nil {
		return err
	}
	handle.updates++
	handle.options.Spec = *update.Schedule.Spec
	handle.options.Action = update.Schedule.Action
	handle.options.Overlap = update.Schedule.Policy.Overlap
	handle.options.CatchupWindow = update.Schedule.Policy.CatchupWindow
	handle.paused = update.Schedule.State.Paused
	return nil
}
func (handle *fakeScheduleHandle) Describe(context.Context) (*client.ScheduleDescription, error) {
	return &client.ScheduleDescription{}, nil
}
func (handle *fakeScheduleHandle) Trigger(context.Context, client.ScheduleTriggerOptions) error {
	return nil
}
func (handle *fakeScheduleHandle) Pause(context.Context, client.SchedulePauseOptions) error {
	handle.paused = true
	return nil
}
func (handle *fakeScheduleHandle) Unpause(context.Context, client.ScheduleUnpauseOptions) error {
	handle.paused = false
	return nil
}

type fakeScheduleClient struct {
	schedules map[string]*fakeScheduleHandle
	creates   int
}

func (fake *fakeScheduleClient) Create(_ context.Context, options client.ScheduleOptions) (client.ScheduleHandle, error) {
	fake.creates++
	if _, exists := fake.schedules[options.ID]; exists {
		return nil, temporal.ErrScheduleAlreadyRunning
	}
	handle := &fakeScheduleHandle{id: options.ID, options: options}
	fake.schedules[options.ID] = handle
	return handle, nil
}

func (fake *fakeScheduleClient) GetHandle(_ context.Context, id string) client.ScheduleHandle {
	if handle, ok := fake.schedules[id]; ok {
		return handle
	}
	return missingHandle{id: id}
}

type missingHandle struct{ id string }

func (handle missingHandle) GetID() string { return handle.id }
func (missingHandle) Delete(context.Context) error {
	return serviceerror.NewNotFound("schedule not found")
}
func (missingHandle) Backfill(context.Context, client.ScheduleBackfillOptions) error { return nil }
func (missingHandle) Update(context.Context, client.ScheduleUpdateOptions) error {
	return serviceerror.NewNotFound("schedule not found")
}
func (missingHandle) Describe(context.Context) (*client.ScheduleDescription, error) {
	return nil, serviceerror.NewNotFound("schedule not found")
}
func (missingHandle) Trigger(context.Context, client.ScheduleTriggerOptions) error { return nil }
func (missingHandle) Pause(context.Context, client.SchedulePauseOptions) error {
	return serviceerror.NewNotFound("schedule not found")
}
func (missingHandle) Unpause(context.Context, client.ScheduleUnpauseOptions) error { return nil }

// Activating registers a Schedule whose action starts the scheduled-run
// workflow with the workflow id; activating again updates the spec and
// unpauses; pausing pauses; archiving deletes, and an absent schedule is
// nothing to pause or delete.
func TestAutomationSchedulesRegisterPauseAndWithdraw(t *testing.T) {
	ctx := context.Background()
	fake := &fakeScheduleClient{schedules: map[string]*fakeScheduleHandle{}}
	schedules, err := orchestration.NewAutomationSchedules(fake, "berry-runs")
	if err != nil {
		t.Fatal(err)
	}
	automationID := uuid.New()
	spec := automationrun.ScheduleSpec{Cron: "0 9 * * 1", Timezone: "Europe/Rome"}
	if err := schedules.Ensure(ctx, automationID, spec); err != nil {
		t.Fatalf("Ensure() error = %v", err)
	}
	handle, ok := fake.schedules[orchestration.AutomationScheduleID(automationID)]
	if !ok {
		t.Fatalf("schedule not created: %+v", fake.schedules)
	}
	action, _ := handle.options.Action.(*client.ScheduleWorkflowAction)
	if action == nil || action.Workflow != orchestration.AutomationScheduledRunName || action.TaskQueue != "berry-runs" ||
		len(action.Args) != 1 || action.Args[0] != automationID.String() || action.ID != orchestration.AutomationScheduleActionID(automationID) {
		t.Fatalf("action = %+v", handle.options.Action)
	}
	if len(handle.options.Spec.CronExpressions) != 1 || handle.options.Spec.CronExpressions[0] != "0 9 * * 1" || handle.options.Spec.TimeZoneName != "Europe/Rome" {
		t.Fatalf("spec = %+v", handle.options.Spec)
	}
	if handle.options.Overlap != enums.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL || handle.options.CatchupWindow != orchestration.AutomationScheduleCatchupWindow {
		t.Fatalf("policies = overlap %v catchup %v", handle.options.Overlap, handle.options.CatchupWindow)
	}

	if err := schedules.Pause(ctx, automationID); err != nil || !handle.paused {
		t.Fatalf("Pause() error = %v paused = %v", err, handle.paused)
	}
	if err := schedules.Ensure(ctx, automationID, automationrun.ScheduleSpec{Cron: "30 8 * * 1-5", Timezone: "UTC"}); err != nil {
		t.Fatalf("Ensure() again error = %v", err)
	}
	if fake.creates != 2 || handle.updates != 1 || handle.paused || handle.options.Spec.CronExpressions[0] != "30 8 * * 1-5" || handle.options.Spec.TimeZoneName != "UTC" {
		t.Fatalf("re-activation: creates %d updates %d paused %v spec %+v", fake.creates, handle.updates, handle.paused, handle.options.Spec)
	}
	if err := schedules.Delete(ctx, automationID); err != nil || !handle.deleted {
		t.Fatalf("Delete() error = %v deleted = %v", err, handle.deleted)
	}
	missing := uuid.New()
	if err := schedules.Pause(ctx, missing); err != nil {
		t.Fatalf("Pause(missing) error = %v", err)
	}
	if err := schedules.Delete(ctx, missing); err != nil {
		t.Fatalf("Delete(missing) error = %v", err)
	}
	if err := schedules.Ensure(ctx, uuid.Nil, spec); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("Ensure(nil) error = %v", err)
	}
	if _, err := orchestration.NewAutomationSchedules(nil, "q"); err == nil {
		t.Fatal("nil client accepted")
	}
	var notFound *serviceerror.NotFound
	if err := (missingHandle{}).Delete(ctx); !errors.As(err, &notFound) {
		t.Fatal("fake handle does not report not found")
	}
}
