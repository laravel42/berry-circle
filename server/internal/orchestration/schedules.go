package orchestration

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// AutomationScheduledRunName is the workflow a Temporal Schedule starts on
// every fire of a schedule-triggered Berry workflow. Persisted in Temporal
// history, so it is a wire contract like the other names.
const AutomationScheduledRunName = "berry.AutomationScheduledRun"

// AutomationScheduleCatchupWindow is how far behind a schedule may fall
// and still fire its missed instants; the in-process scheduler uses the
// same window so both paths create the same rows.
const AutomationScheduleCatchupWindow = automationrepo.DefaultCatchupWindow

// scheduledRunTimeout bounds the scheduled-run workflow itself: it creates
// one row and starts one child, and must not linger.
const scheduledRunTimeout = 10 * time.Minute

// scheduledStartTime is the search attribute Temporal stamps on a workflow a
// Schedule started: the nominal fire time, which is what makes the run's
// source key the same instant on both execution paths.
var scheduledStartTime = temporal.NewSearchAttributeKeyTime("TemporalScheduledStartTime")

// AutomationScheduledRun is one fire of a schedule trigger: it records the
// run for the nominal instant (idempotent on that instant, so a retried
// action never creates a second row) and starts the run's orchestration as
// an abandoned child, which then lives exactly as a dispatcher-started run
// does. A workflow that is no longer active records nothing.
func AutomationScheduledRun(ctx workflow.Context, automationID string) error {
	logger := workflow.GetLogger(ctx)
	fireTime, ok := workflow.GetTypedSearchAttributes(ctx).GetTime(scheduledStartTime)
	if !ok {
		// Started outside a Schedule (a manual trigger of the schedule, a
		// test): the current minute is the instant.
		fireTime = workflow.Now(ctx).UTC().Truncate(time.Minute)
	}
	activityCtx := workflow.WithActivityOptions(ctx, ledgerActivityOptions())
	var runID string
	if err := workflow.ExecuteActivity(activityCtx, (*Activities).CreateScheduledRun, automationID, fireTime.UTC()).Get(activityCtx, &runID); err != nil {
		return err
	}
	if runID == "" {
		logger.Info("scheduled run skipped: workflow is not active", "automationId", automationID, "fireTime", fireTime)
		return nil
	}
	parsed, err := uuid.Parse(runID)
	if err != nil {
		return fmt.Errorf("scheduled run id: %w", err)
	}
	childCtx := workflow.WithChildOptions(ctx, workflow.ChildWorkflowOptions{
		WorkflowID:            AutomationRunWorkflowID(parsed),
		WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		ParentClosePolicy:     enums.PARENT_CLOSE_POLICY_ABANDON,
		WorkflowRunTimeout:    AutomationRunTimeout,
	})
	var execution workflow.Execution
	if err := workflow.ExecuteChildWorkflow(childCtx, AutomationOrchestrationName, runID).GetChildWorkflowExecution().Get(ctx, &execution); err != nil {
		var started *temporal.ChildWorkflowExecutionAlreadyStartedError
		if errors.As(err, &started) {
			// The dispatcher's signal-with-start or a previous attempt got
			// there first; the run is being executed either way.
			return nil
		}
		return err
	}
	logger.Info("scheduled run started", "automationId", automationID, "runId", runID, "fireTime", fireTime)
	return nil
}

// ScheduleClient is what the schedule seam needs from a Temporal client.
// client.Client.ScheduleClient() satisfies it; tests use a fake.
type ScheduleClient interface {
	Create(ctx context.Context, options client.ScheduleOptions) (client.ScheduleHandle, error)
	GetHandle(ctx context.Context, scheduleID string) client.ScheduleHandle
}

// AutomationSchedules fires schedule triggers through Temporal Schedules.
// It satisfies automationrun.Schedules: activation creates or updates the
// schedule, pausing pauses it, archiving deletes it. Every fire starts
// AutomationScheduledRun with the workflow id; the Schedule appends the
// nominal time to the action's workflow id, so two fires never collide.
type AutomationSchedules struct {
	client    ScheduleClient
	taskQueue string
}

// NewAutomationSchedules validates its dependencies at construction.
func NewAutomationSchedules(schedules ScheduleClient, taskQueue string) (*AutomationSchedules, error) {
	if schedules == nil {
		return nil, errors.New("temporal schedule client is nil")
	}
	if taskQueue == "" {
		return nil, errors.New("temporal task queue is required")
	}
	return &AutomationSchedules{client: schedules, taskQueue: taskQueue}, nil
}

// AutomationScheduleActionID is the workflow id prefix of the runs a
// Schedule starts; Temporal appends the nominal fire time.
func AutomationScheduleActionID(automationID uuid.UUID) string {
	return "automation-schedule-run:" + automationID.String()
}

func scheduleSpec(spec automationrun.ScheduleSpec) client.ScheduleSpec {
	return client.ScheduleSpec{CronExpressions: []string{spec.Cron}, TimeZoneName: spec.Timezone}
}

func (schedules *AutomationSchedules) action(automationID uuid.UUID) *client.ScheduleWorkflowAction {
	return &client.ScheduleWorkflowAction{
		ID:                 AutomationScheduleActionID(automationID),
		Workflow:           AutomationScheduledRunName,
		Args:               []interface{}{automationID.String()},
		TaskQueue:          schedules.taskQueue,
		WorkflowRunTimeout: scheduledRunTimeout,
	}
}

// Ensure creates the schedule, or brings an existing one up to date and
// unpauses it. Overlap is allowed on purpose: a run parked on a person
// must not stop the next instant from creating its own run, and the run
// row is idempotent per instant anyway.
func (schedules *AutomationSchedules) Ensure(ctx context.Context, automationID uuid.UUID, spec automationrun.ScheduleSpec) error {
	if schedules == nil {
		return errors.New("temporal schedules are not configured")
	}
	if automationID == uuid.Nil || spec.Cron == "" || spec.Timezone == "" {
		return errors.New("schedule parameters are invalid")
	}
	_, err := schedules.client.Create(ctx, client.ScheduleOptions{
		ID:            AutomationScheduleID(automationID),
		Spec:          scheduleSpec(spec),
		Action:        schedules.action(automationID),
		Overlap:       enums.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL,
		CatchupWindow: AutomationScheduleCatchupWindow,
	})
	if err == nil {
		return nil
	}
	var exists *serviceerror.AlreadyExists
	if !errors.Is(err, temporal.ErrScheduleAlreadyRunning) && !errors.As(err, &exists) {
		return fmt.Errorf("create automation schedule: %w", err)
	}
	handle := schedules.client.GetHandle(ctx, AutomationScheduleID(automationID))
	err = handle.Update(ctx, client.ScheduleUpdateOptions{
		DoUpdate: func(input client.ScheduleUpdateInput) (*client.ScheduleUpdate, error) {
			schedule := input.Description.Schedule
			updated := scheduleSpec(spec)
			schedule.Spec = &updated
			schedule.Action = schedules.action(automationID)
			if schedule.Policy == nil {
				schedule.Policy = &client.SchedulePolicies{}
			}
			schedule.Policy.Overlap = enums.SCHEDULE_OVERLAP_POLICY_ALLOW_ALL
			schedule.Policy.CatchupWindow = AutomationScheduleCatchupWindow
			if schedule.State == nil {
				schedule.State = &client.ScheduleState{}
			}
			schedule.State.Paused = false
			schedule.State.Note = "active in Berry"
			return &client.ScheduleUpdate{Schedule: &schedule}, nil
		},
	})
	if err != nil {
		return fmt.Errorf("update automation schedule: %w", err)
	}
	return nil
}

// Pause stops the schedule from firing; a schedule that does not exist has
// nothing to pause.
func (schedules *AutomationSchedules) Pause(ctx context.Context, automationID uuid.UUID) error {
	if schedules == nil {
		return errors.New("temporal schedules are not configured")
	}
	err := schedules.client.GetHandle(ctx, AutomationScheduleID(automationID)).Pause(ctx, client.SchedulePauseOptions{Note: "paused in Berry"})
	if err != nil && !notFound(err) {
		return fmt.Errorf("pause automation schedule: %w", err)
	}
	return nil
}

// Delete removes the schedule; an absent one is success.
func (schedules *AutomationSchedules) Delete(ctx context.Context, automationID uuid.UUID) error {
	if schedules == nil {
		return errors.New("temporal schedules are not configured")
	}
	err := schedules.client.GetHandle(ctx, AutomationScheduleID(automationID)).Delete(ctx)
	if err != nil && !notFound(err) {
		return fmt.Errorf("delete automation schedule: %w", err)
	}
	return nil
}

func notFound(err error) bool {
	var missing *serviceerror.NotFound
	return errors.As(err, &missing)
}

var _ automationrun.Schedules = (*AutomationSchedules)(nil)
