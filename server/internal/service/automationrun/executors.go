package automationrun

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
)

// maxFailureMessage bounds what a step records about why it failed.
const maxFailureMessage = 500

// StepError is a step failure with a stable code. Anything an executor
// returns that is not a StepError is recorded as STEP_FAILED.
type StepError struct {
	Code    string
	Message string
	// Usage is what a failed paid call still cost, kept on the run.
	Usage *automation.Usage
	Err   error
}

func (err *StepError) Error() string {
	if err.Err != nil {
		return err.Code + ": " + err.Message + ": " + err.Err.Error()
	}
	return err.Code + ": " + err.Message
}

func (err *StepError) Unwrap() error { return err.Err }

func stepFailure(code, message string) *StepError {
	return &StepError{Code: code, Message: message}
}

func wrapFailure(code, message string, cause error) *StepError {
	return &StepError{Code: code, Message: message, Err: cause}
}

// toFailure maps an executor error to the ledger's failure shape.
func toFailure(err error) (automationrepo.Failure, *automation.Usage) {
	var stepErr *StepError
	if errors.As(err, &stepErr) {
		return automationrepo.Failure{Code: stepErr.Code, Message: bounded(stepErr.Message)}, stepErr.Usage
	}
	return automationrepo.Failure{Code: "STEP_FAILED", Message: bounded(err.Error())}, nil
}

func bounded(text string) string {
	if len(text) <= maxFailureMessage {
		return text
	}
	cut := text[:maxFailureMessage]
	for !utf8.ValidString(cut) && len(cut) > 0 {
		cut = cut[:len(cut)-1]
	}
	return cut
}

// stepCall is everything one execution needs.
type stepCall struct {
	run        automationrepo.Run
	automation automationrepo.Automation
	step       automation.Step
	row        automationrepo.StepRun
	scope      automation.Scope
	approved   bool
	approvalID *uuid.UUID
}

// context builds the executor-facing view of the call.
func (call stepCall) context(now func() uuid.UUID) automation.StepContext {
	var requestedBy uuid.UUID
	if call.run.RequestedBy != nil {
		requestedBy = *call.run.RequestedBy
	} else if call.automation.CreatedBy != nil {
		requestedBy = *call.automation.CreatedBy
	}
	return automation.StepContext{
		WorkspaceID:  call.run.WorkspaceID,
		AutomationID: call.run.AutomationID,
		RunID:        call.run.ID,
		StepRunID:    call.row.ID,
		Step:         call.step,
		Scope:        call.scope,
		RequestedBy:  requestedBy,
		GoalID:       call.run.GoalID,
		Approved:     call.approved,
		ApprovalID:   call.approvalID,
	}
}

// executeStep runs one step natively. The MVP set (spec §42) executes; the
// rest fail with NODE_TYPE_UNSUPPORTED until their executors land.
func (runner *Runner) executeStep(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	if ctx.Err() != nil {
		return automation.StepOutcome{}, wrapFailure("STEP_INTERRUPTED", "The step was interrupted.", ctx.Err())
	}
	switch call.step.Type {
	case automation.StepCondition:
		return runner.executeCondition(call)
	case automation.StepWait:
		return runner.executeWait(call)
	case automation.StepApproval:
		return runner.executeApproval(ctx, call)
	case automation.StepCreateIssue:
		return runner.executeCreateIssue(ctx, call)
	case automation.StepUpdateIssue:
		return runner.executeUpdateIssue(ctx, call)
	case automation.StepAgent:
		return runner.executeAgent(ctx, call)
	case automation.StepAction:
		return runner.executeAction(ctx, call)
	default:
		return automation.StepOutcome{}, stepFailure("NODE_TYPE_UNSUPPORTED",
			fmt.Sprintf("Step type %q cannot be executed yet.", call.step.Type))
	}
}

func succeeded(output any) automation.StepOutcome {
	encoded, err := json.Marshal(output)
	if err != nil {
		encoded = json.RawMessage(`{}`)
	}
	return automation.StepOutcome{Status: automation.StepSucceeded, Output: encoded}
}

func waiting(key string, output any) automation.StepOutcome {
	encoded, err := json.Marshal(output)
	if err != nil {
		encoded = json.RawMessage(`{}`)
	}
	return automation.StepOutcome{Status: automation.StepWaiting, WaitingOn: key, Output: encoded}
}

// render resolves a template against the scope, failing the step when a
// reference reads nothing: a blank shipped into a provider is worse than a
// stopped run.
func render(text string, scope automation.Scope) (string, error) {
	if text == "" {
		return "", nil
	}
	rendered, err := automation.Render(text, scope)
	if err != nil {
		return "", wrapFailure("TEMPLATE_RESOLUTION_FAILED", err.Error(), err)
	}
	return rendered, nil
}

// resolveInput resolves every input value through references and templates.
func resolveInput(input map[string]json.RawMessage, scope automation.Scope) (map[string]any, error) {
	resolved := make(map[string]any, len(input))
	for key, raw := range input {
		value, err := automation.ResolveValue(raw, scope)
		if err != nil {
			return nil, wrapFailure("INPUT_INVALID", fmt.Sprintf("Input %q: %s", key, err.Error()), err)
		}
		resolved[key] = value
	}
	return resolved, nil
}

// inputString reads one string input; absent reads as empty.
func inputString(input map[string]any, key string) string {
	switch value := input[key].(type) {
	case string:
		return value
	case nil:
		return ""
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

func inputUUID(input map[string]any, key string) (uuid.UUID, bool) {
	parsed, err := uuid.Parse(inputString(input, key))
	return parsed, err == nil && parsed != uuid.Nil
}

func actor(call stepCall) (uuid.UUID, error) {
	if call.run.RequestedBy != nil && *call.run.RequestedBy != uuid.Nil {
		return *call.run.RequestedBy, nil
	}
	if call.automation.CreatedBy != nil && *call.automation.CreatedBy != uuid.Nil {
		return *call.automation.CreatedBy, nil
	}
	return uuid.Nil, stepFailure("ACTOR_UNAVAILABLE", "The workflow has no creator left to act on behalf of.")
}
