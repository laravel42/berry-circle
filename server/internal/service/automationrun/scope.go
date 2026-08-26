package automationrun

import (
	"context"
	"encoding/json"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// scope builds the value tree references resolve against for one step row:
// the trigger payload, every finished step's output, the goal the run
// serves and, inside a loop, the current item beside the same iteration's
// body outputs. A finished loop exposes {count, items, results} where
// results[i] holds the body outputs of item i. Connections are
// intentionally empty in native execution: no credential or account
// metadata reaches a template.
func (runner *Runner) scope(
	ctx context.Context,
	run automationrepo.Run,
	definition automation.Definition,
	state map[string]automationrepo.StepRun,
	stepRunID string,
) automation.Scope {
	scope := automation.Scope{
		"trigger":     rawObject(run.TriggerPayload),
		"steps":       map[string]any{},
		"connections": map[string]any{},
	}
	outputs := scope["steps"].(map[string]any)
	iterations := map[string]map[int]any{}
	for id, step := range state {
		if step.Status != automationrepo.StepSucceeded {
			continue
		}
		base, index, indexed := automation.SplitStepRunID(id)
		if !indexed {
			outputs[base] = map[string]any{"output": rawValue(step.Output)}
			continue
		}
		if iterations[base] == nil {
			iterations[base] = map[int]any{}
		}
		iterations[base][index] = rawValue(step.Output)
	}
	loops := loopsOf(definition)
	for _, step := range definition.Steps {
		if step.Type != automation.StepForeach || step.Foreach == nil {
			continue
		}
		row, ok := state[step.ID]
		if !ok || row.Status != automationrepo.StepSucceeded {
			continue
		}
		loop := rawObject(row.Output)
		count := foreachCount(row.Output)
		results := make([]any, 0, count)
		for index := 0; index < count; index++ {
			result := map[string]any{}
			for _, body := range step.Foreach.Steps {
				if output, ok := iterations[body][index]; ok {
					result[body] = output
				}
			}
			results = append(results, result)
		}
		loop["results"] = results
		outputs[step.ID] = map[string]any{"output": loop}
	}
	if base, index, indexed := automation.SplitStepRunID(stepRunID); indexed {
		if loop, ok := loops[base]; ok {
			if row, ok := state[loop.ID]; ok {
				items, _ := rawObject(row.Output)["items"].([]any)
				if index >= 0 && index < len(items) {
					scope["item"] = items[index]
				}
			}
			for _, body := range loop.Foreach.Steps {
				if output, ok := iterations[body][index]; ok {
					outputs[body] = map[string]any{"output": output}
				}
			}
		}
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

// loopsOf maps each body step to its foreach.
func loopsOf(definition automation.Definition) map[string]automation.Step {
	loops := map[string]automation.Step{}
	for _, step := range definition.Steps {
		if step.Type != automation.StepForeach || step.Foreach == nil {
			continue
		}
		for _, body := range step.Foreach.Steps {
			loops[body] = step
		}
	}
	return loops
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
