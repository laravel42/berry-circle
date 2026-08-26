package automationrun

import (
	"context"
	"encoding/json"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// scope builds the value tree references resolve against: the trigger
// payload, every finished step's output, and the goal the run serves.
// Connections are intentionally empty in native execution: no credential or
// account metadata reaches a template.
func (runner *Runner) scope(ctx context.Context, run automationrepo.Run, state map[string]automationrepo.StepRun) automation.Scope {
	scope := automation.Scope{
		"trigger":     rawObject(run.TriggerPayload),
		"steps":       map[string]any{},
		"connections": map[string]any{},
	}
	outputs := scope["steps"].(map[string]any)
	for id, step := range state {
		if step.Status != automationrepo.StepSucceeded {
			continue
		}
		outputs[id] = map[string]any{"output": rawValue(step.Output)}
	}
	if run.GoalID != nil && runner.options.Goals != nil {
		if goal, err := runner.options.Goals.Get(ctx, *run.GoalID); err == nil {
			entry := map[string]any{
				"id":     goal.ID.String(),
				"title":  goal.Title,
				"status": string(goal.Status),
			}
			if goal.ProjectID != nil {
				entry["projectId"] = goal.ProjectID.String()
			}
			scope["goal"] = entry
		}
	}
	return scope
}

// rawObject decodes JSON into a map; anything that is not an object
// becomes an empty one so a reference into it resolves to nothing rather
// than panicking.
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
