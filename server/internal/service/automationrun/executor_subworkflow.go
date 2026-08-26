package automationrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// executeSubworkflow starts a child run of another active workflow in the
// same workspace, with the resolved input as its trigger.input, and parks
// on it. The child run is idempotent on the step row, so a re-executed
// step finds the child it already started. The run is a manual run of the
// child with the parent recorded on the row and in its trigger payload.
func (runner *Runner) executeSubworkflow(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	step := call.step.Subworkflow
	if step == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The subworkflow step names no workflow.")
	}
	starter := runner.subrunStarter()
	if starter == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Subworkflow execution is not configured.")
	}
	childID, err := uuid.Parse(step.WorkflowID)
	if err != nil || childID == uuid.Nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The subworkflow id is not a UUID.")
	}
	if childID == call.run.AutomationID {
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_CYCLE", "A workflow cannot call itself.")
	}
	if call.run.Depth+1 > automation.MaxSubworkflowDepth {
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_DEPTH_EXCEEDED",
			fmt.Sprintf("Subworkflows nest at most %d levels deep.", automation.MaxSubworkflowDepth))
	}
	child, err := runner.options.Store.Get(ctx, childID)
	if err != nil || child.WorkspaceID != call.run.WorkspaceID {
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_NOT_FOUND", "The subworkflow is not in this workspace.")
	}
	if child.Status != automationrepo.StatusActive {
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_NOT_ACTIVE", "Only an active workflow can be called.")
	}
	input, err := resolveInput(step.Input, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"input": input,
		"parent": map[string]any{
			"workflowId": call.run.AutomationID.String(), "runId": call.run.ID.String(),
			"stepRunId": call.row.ID.String(), "stepId": call.row.StepID,
		},
	})
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("INPUT_INVALID", "The subworkflow input cannot be encoded.", err)
	}
	key := "subworkflow:" + call.row.ID.String()
	parentRunID, parentStepRunID := call.run.ID, call.row.ID
	run, created, err := runner.options.Store.CreateRun(ctx, automationrepo.CreateRunParams{
		ID: runner.options.NewID(), AutomationID: child.ID, TriggerType: automation.TriggerManual, Payload: payload,
		SourceEventKey: &key, RequestedBy: call.run.RequestedBy, RequestID: key,
		ParentRunID: &parentRunID, ParentStepRunID: &parentStepRunID, Depth: call.run.Depth + 1,
		CreatedAt: runner.now(),
	})
	if err != nil {
		if errors.Is(err, automationrepo.ErrNotActive) {
			return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_NOT_ACTIVE", "Only an active workflow can be called.")
		}
		return automation.StepOutcome{}, wrapFailure("SUBWORKFLOW_START_FAILED", "The subworkflow run could not be created.", err)
	}
	if !created && run.Status.Terminal() {
		// A re-executed step whose child already finished settles now.
		return runner.subworkflowOutcome(ctx, ResumeSignal{Kind: SignalRun, ID: run.ID, Outcome: subworkflowOutcomeOf(run.Status)})
	}
	if created {
		if err := starter.Start(ctx, run.ID); err != nil {
			return automation.StepOutcome{}, wrapFailure("SUBWORKFLOW_START_FAILED", "The subworkflow run was created but could not be started.", err)
		}
	}
	return waiting("run:"+run.ID.String(), map[string]any{"childRunId": run.ID.String(), "workflowId": child.ID.String()}), nil
}

func subworkflowOutcomeOf(status automationrepo.RunStatus) string {
	switch status {
	case automationrepo.RunSucceeded:
		return "completed"
	case automationrepo.RunCancelled:
		return "cancelled"
	default:
		return "failed"
	}
}

// subworkflowOutcome is the step output once the child run ended: its
// status and the outputs of its succeeded steps keyed by step id, with a
// loop's rows folded under the loop as results.
func (runner *Runner) subworkflowOutcome(ctx context.Context, signal ResumeSignal) (automation.StepOutcome, error) {
	child, steps, err := runner.options.Store.GetRunWithSteps(ctx, signal.ID)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("SUBWORKFLOW_FAILED", "The subworkflow run could not be read.", err)
	}
	switch child.Status {
	case automationrepo.RunSucceeded:
	case automationrepo.RunFailed:
		message := "The subworkflow run failed."
		if child.Failure != nil {
			message = "The subworkflow run failed (" + child.Failure.Code + ")."
		}
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_FAILED", message)
	case automationrepo.RunCancelled:
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_CANCELLED", "The subworkflow run was cancelled.")
	default:
		return automation.StepOutcome{}, stepFailure("SUBWORKFLOW_FAILED", "The subworkflow run has not finished.")
	}
	outputs := map[string]any{}
	iterations := map[string]map[int]any{}
	for id, row := range latestByStep(steps) {
		if row.Status != automationrepo.StepSucceeded {
			continue
		}
		base, index, indexed := automation.SplitStepRunID(id)
		if !indexed {
			outputs[base] = rawValue(row.Output)
			continue
		}
		if iterations[base] == nil {
			iterations[base] = map[int]any{}
		}
		iterations[base][index] = rawValue(row.Output)
	}
	for body, byIndex := range iterations {
		results := make([]any, 0, len(byIndex))
		for index := 0; index < len(byIndex); index++ {
			results = append(results, byIndex[index])
		}
		outputs[body] = results
	}
	return succeeded(map[string]any{
		"childRunId": child.ID.String(), "workflowId": child.AutomationID.String(),
		"status": string(child.Status), "steps": outputs,
	}), nil
}
