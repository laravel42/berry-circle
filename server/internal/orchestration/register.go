package orchestration

import (
	"errors"

	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// Register wires every Berry workflow and activity onto a worker.
//
// Workflow type names are pinned explicitly rather than derived from the Go
// function name: a rename would otherwise strand in-flight executions whose
// history records the old name.
func Register(w worker.Worker, activities *Activities) error {
	if w == nil {
		return errors.New("orchestration worker is nil")
	}
	if activities == nil {
		return errors.New("orchestration activities are nil")
	}
	w.RegisterWorkflowWithOptions(
		RunOrchestration,
		workflow.RegisterOptions{Name: RunOrchestrationName},
	)
	w.RegisterWorkflowWithOptions(
		IntakeOrchestration,
		workflow.RegisterOptions{Name: IntakeOrchestrationName},
	)
	w.RegisterWorkflowWithOptions(
		AutomationOrchestration,
		workflow.RegisterOptions{Name: AutomationOrchestrationName},
	)
	w.RegisterActivity(activities)
	return nil
}
