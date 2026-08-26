package automationrun

import (
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
