package automationrun

import (
	"fmt"
	"reflect"
	"time"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
)

// executeCondition evaluates the typed expression and names the branch the
// run takes; the other branch is pruned by the runner.
func (runner *Runner) executeCondition(call stepCall) (automation.StepOutcome, error) {
	condition := call.step.Condition
	if condition == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The condition step has no expression.")
	}
	result, err := automation.Evaluate(condition.Expression, call.scope)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("CONDITION_EVALUATION_FAILED", err.Error(), err)
	}
	next := condition.TrueSteps
	if !result {
		next = condition.FalseSteps
	}
	if next == nil {
		next = []string{}
	}
	outcome := succeeded(map[string]any{"result": result, "next": next})
	outcome.Next = next
	return outcome, nil
}

// executeWait parks the run on a timer or an event. An until that already
// passed is not a wait.
func (runner *Runner) executeWait(call stepCall) (automation.StepOutcome, error) {
	wait := call.step.Wait
	if wait == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The wait step has no mode.")
	}
	now := runner.now()
	switch wait.Mode {
	case automation.WaitModeDuration:
		duration, ok := automation.ParseDuration(wait.Duration)
		if !ok {
			return automation.StepOutcome{}, stepFailure("WAIT_INVALID", "The wait duration is not an ISO-8601 duration.")
		}
		resumeAt := now.Add(duration)
		outcome := waiting("timer", map[string]any{"resumeAt": resumeAt.Format(time.RFC3339Nano)})
		outcome.ResumeAt = &resumeAt
		return outcome, nil
	case automation.WaitModeUntil:
		text, err := render(wait.Until, call.scope)
		if err != nil {
			return automation.StepOutcome{}, err
		}
		instant, err := time.Parse(time.RFC3339, text)
		if err != nil {
			return automation.StepOutcome{}, stepFailure("WAIT_INVALID", "The wait instant is not RFC 3339.")
		}
		if !instant.After(now) {
			return succeeded(map[string]any{"resumedAt": now.Format(time.RFC3339Nano), "until": instant.UTC().Format(time.RFC3339Nano)}), nil
		}
		resumeAt := instant.UTC()
		outcome := waiting("timer", map[string]any{"resumeAt": resumeAt.Format(time.RFC3339Nano)})
		outcome.ResumeAt = &resumeAt
		return outcome, nil
	case automation.WaitModeEvent:
		if wait.Event == nil || wait.Event.Event == "" {
			return automation.StepOutcome{}, stepFailure("WAIT_INVALID", "The event wait names no event.")
		}
		topic := wait.Event.Event
		if wait.Event.Provider != "" && wait.Event.Provider != providers.ProviderBerry {
			topic = wait.Event.Provider + "." + wait.Event.Event
		}
		return waiting("event:"+topic, map[string]any{"topic": topic}), nil
	default:
		return automation.StepOutcome{}, stepFailure("WAIT_INVALID", "The wait mode is unknown.")
	}
}

// executeSwitch resolves the value and takes the first case whose equals
// matches it, else the default branch; the runner prunes the rest.
func (runner *Runner) executeSwitch(call stepCall) (automation.StepOutcome, error) {
	branch := call.step.Switch
	if branch == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The switch step has no value.")
	}
	value, err := automation.ResolveValue(branch.Value, call.scope)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("INPUT_INVALID", "The switch value: "+err.Error(), err)
	}
	next := branch.DefaultSteps
	var matched any
	for index, item := range branch.Cases {
		expected, err := automation.ResolveValue(item.Equals, call.scope)
		if err != nil {
			return automation.StepOutcome{}, wrapFailure("INPUT_INVALID", fmt.Sprintf("Case %d: %s", index, err.Error()), err)
		}
		if reflect.DeepEqual(value, expected) {
			next = item.Steps
			matched = index
			break
		}
	}
	if next == nil {
		next = []string{}
	}
	outcome := succeeded(map[string]any{"value": value, "case": matched, "next": next})
	outcome.Next = next
	return outcome, nil
}

// executeTransform evaluates every output field through references and
// templates; the result is the step's output and nothing else happens.
func (runner *Runner) executeTransform(call stepCall) (automation.StepOutcome, error) {
	transform := call.step.Transform
	if transform == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The transform step has no output.")
	}
	output, err := resolveInput(transform.Output, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	return succeeded(output), nil
}

// executeForeach resolves the items and records them; the runner then fans
// the body out as one row per body step per item, in item order. An array
// past maxItems fails rather than being cut short: silently dropping the
// tail would hide the very rows a person expected to see.
func (runner *Runner) executeForeach(call stepCall) (automation.StepOutcome, error) {
	loop := call.step.Foreach
	if loop == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The foreach step has no items.")
	}
	value, err := automation.ResolveValue(loop.Items, call.scope)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("INPUT_INVALID", "The foreach items: "+err.Error(), err)
	}
	items, ok := value.([]any)
	if !ok {
		return automation.StepOutcome{}, stepFailure("FOREACH_NOT_ITERABLE", "The foreach items did not resolve to an array.")
	}
	limit := loop.MaxItems
	if limit <= 0 {
		limit = automation.DefaultForeachItems
	}
	if limit > automation.MaxForeachItems {
		limit = automation.MaxForeachItems
	}
	if len(items) > limit {
		return automation.StepOutcome{}, stepFailure("FOREACH_LIMIT_EXCEEDED",
			fmt.Sprintf("The foreach received %d items; maxItems is %d.", len(items), limit))
	}
	return succeeded(map[string]any{"count": len(items), "items": items}), nil
}
