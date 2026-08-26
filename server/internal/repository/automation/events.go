package automation

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// automationResource is the workflow as a stream consumer sees it.
type automationResource struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspaceId"`
	ProjectID   *uuid.UUID `json:"projectId"`
	GoalID      *uuid.UUID `json:"goalId"`
	Name        string     `json:"name"`
	Status      Status     `json:"status"`
	Version     int        `json:"version"`
	Revision    int        `json:"revision"`
	TriggerType string     `json:"triggerType"`
	Risk        string     `json:"risk"`
	Engine      Engine     `json:"engine"`
	UpdatedAt   string     `json:"updatedAt"`
}

type automationEventPayload struct {
	Workflow automationResource `json:"workflow"`
	Actor    *core.ActorKey     `json:"actor,omitempty"`
}

// writeAutomationEvent persists one workflow.* lifecycle fact on the
// workspace stream.
func writeAutomationEvent(
	ctx context.Context,
	tx database,
	topic string,
	item Automation,
	actor *core.ActorKey,
	occurredAt time.Time,
	newID func() uuid.UUID,
) (Event, error) {
	if newID == nil {
		newID = uuid.New
	}
	payload, err := json.Marshal(automationEventPayload{
		Workflow: automationResource{
			ID: item.ID, WorkspaceID: item.WorkspaceID, ProjectID: item.ProjectID, GoalID: item.GoalID,
			Name: item.Name, Status: item.Status, Version: item.Version, Revision: item.Revision,
			TriggerType: string(item.Trigger.Type), Risk: string(item.Risk), Engine: item.Engine,
			UpdatedAt: item.UpdatedAt.UTC().Format(time.RFC3339Nano),
		},
		Actor: actor,
	})
	if err != nil {
		return Event{}, errors.New("encode workflow event payload")
	}
	return ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID:            newID(),
		Topic:         topic,
		AggregateType: "automation",
		AggregateID:   item.ID,
		WorkspaceID:   item.WorkspaceID,
		Payload:       payload,
		OccurredAt:    occurredAt,
	})
}

// runResource is the run as a stream consumer sees it. Wire names say
// workflow; storage says automation.
type runResource struct {
	ID              uuid.UUID        `json:"id"`
	WorkflowID      uuid.UUID        `json:"workflowId"`
	WorkflowVersion int              `json:"workflowVersion"`
	GoalID          *uuid.UUID       `json:"goalId"`
	Status          RunStatus        `json:"status"`
	TriggerType     string           `json:"triggerType"`
	CurrentStepID   *string          `json:"currentStepId"`
	WaitingOn       *string          `json:"waitingOn"`
	ResumeAt        *string          `json:"resumeAt"`
	Failure         *failureResource `json:"failure"`
	Usage           usageResource    `json:"usage"`
	CreatedAt       string           `json:"createdAt"`
	StartedAt       *string          `json:"startedAt"`
	CompletedAt     *string          `json:"completedAt"`
}

type failureResource struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type usageResource struct {
	InputTokens  int64  `json:"inputTokens"`
	OutputTokens int64  `json:"outputTokens"`
	CostMicros   *int64 `json:"costMicros"`
}

// stepResource is a step attempt as a stream consumer sees it. Input and
// output are omitted: they can be large and the run resource carries them.
type stepResource struct {
	ID          uuid.UUID        `json:"id"`
	StepID      string           `json:"stepId"`
	StepType    string           `json:"stepType"`
	Attempt     int              `json:"attempt"`
	Status      StepStatus       `json:"status"`
	Failure     *failureResource `json:"failure"`
	RunID       *uuid.UUID       `json:"runId"`
	IssueID     *uuid.UUID       `json:"issueId"`
	ApprovalID  *uuid.UUID       `json:"approvalId"`
	StartedAt   *string          `json:"startedAt"`
	CompletedAt *string          `json:"completedAt"`
}

// runEventPayload is the ledger payload of every workflow.run.* and
// workflow.step.* event. The ids are repeated at the top so the SSE frame
// and the inbox projector never parse the nested resource for them.
type runEventPayload struct {
	WorkflowID    uuid.UUID      `json:"workflowId"`
	WorkflowRunID uuid.UUID      `json:"workflowRunId"`
	StepID        *string        `json:"stepId,omitempty"`
	WaitingOn     *string        `json:"waitingOn,omitempty"`
	Run           *runResource   `json:"run,omitempty"`
	Step          *stepResource  `json:"step,omitempty"`
	Actor         *core.ActorKey `json:"actor,omitempty"`
}

func serializeRun(run Run) *runResource {
	resource := &runResource{
		ID: run.ID, WorkflowID: run.AutomationID, WorkflowVersion: run.AutomationVersion, GoalID: run.GoalID,
		Status: run.Status, TriggerType: string(run.TriggerType), CurrentStepID: run.CurrentStepID,
		WaitingOn: run.WaitingOn, ResumeAt: formatTime(run.ResumeAt),
		Usage:     usageResource{InputTokens: run.Usage.InputTokens, OutputTokens: run.Usage.OutputTokens, CostMicros: run.Usage.CostMicros},
		CreatedAt: run.CreatedAt.UTC().Format(time.RFC3339Nano),
		StartedAt: formatTime(run.StartedAt), CompletedAt: formatTime(run.CompletedAt),
	}
	if run.Failure != nil {
		resource.Failure = &failureResource{Code: run.Failure.Code, Message: run.Failure.Message}
	}
	return resource
}

func serializeStep(step StepRun) *stepResource {
	resource := &stepResource{
		ID: step.ID, StepID: step.StepID, StepType: string(step.StepType), Attempt: step.Attempt, Status: step.Status,
		RunID: step.IssueRunID, IssueID: step.IssueID, ApprovalID: step.ApprovalID,
		StartedAt: formatTime(step.StartedAt), CompletedAt: formatTime(step.CompletedAt),
	}
	if step.Failure != nil {
		resource.Failure = &failureResource{Code: step.Failure.Code, Message: step.Failure.Message}
	}
	return resource
}

// appendRunEvent writes one run ledger row and its outbox twin with the same
// id, exactly as the issue run ledger does, so a stream cursor is valid on
// both replays. The sequence and instant are allocated under the run's row
// lock, which every caller holds.
func appendRunEvent(
	ctx context.Context,
	tx database,
	run Run,
	topic string,
	payload runEventPayload,
	requested time.Time,
	newID func() uuid.UUID,
) (Event, error) {
	if newID == nil {
		newID = uuid.New
	}
	payload.WorkflowID = run.AutomationID
	payload.WorkflowRunID = run.ID
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Event{}, errors.New("encode workflow run event payload")
	}
	sequence, err := ledger.Sequence(ctx, tx, ledger.AutomationRuns, run.ID)
	if err != nil {
		return Event{}, err
	}
	occurredAt, err := ledger.NextOccurredAt(ctx, tx, ledger.AutomationRuns, run.ID, requested)
	if err != nil {
		return Event{}, err
	}
	id := newID()
	if err := ledger.Append(ctx, tx, ledger.AutomationRuns, ledger.Row{
		ID: id, OwnerID: run.ID, Scope: []uuid.UUID{run.WorkspaceID}, Sequence: sequence,
		Type: topic, Payload: encoded, Public: true, OccurredAt: occurredAt,
	}); err != nil {
		return Event{}, err
	}
	event, err := ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID: id, Topic: topic, AggregateType: "automation_run", AggregateID: run.ID,
		WorkspaceID: run.WorkspaceID, Payload: encoded, OccurredAt: occurredAt,
	})
	if err != nil {
		return Event{}, err
	}
	event.Sequence = &sequence
	return event, nil
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
