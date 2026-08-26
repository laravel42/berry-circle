package automationrun

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

// maxAgentMessageBytes is the upstream message limit.
const maxAgentMessageBytes = 64 * 1024

// agentSpec is an agent step (or ask_agent / run_agent tool call) before
// templates resolve.
type agentSpec struct {
	AgentID              string
	RequiredCapabilities []string
	Instruction          string
	Input                map[string]json.RawMessage
	OutputSchema         json.RawMessage
	IssueMode            automation.IssueMode
}

func (runner *Runner) executeAgent(ctx context.Context, call stepCall) (automation.StepOutcome, error) {
	agent := call.step.Agent
	if agent == nil {
		return automation.StepOutcome{}, stepFailure("DEFINITION_INVALID", "The agent step has no instruction.")
	}
	spec := agentSpec{
		AgentID: agent.AgentID, RequiredCapabilities: agent.RequiredCapabilities, Instruction: agent.Instruction,
		Input: agent.Input, OutputSchema: agent.OutputSchema, IssueMode: agent.IssueMode,
	}
	if spec.IssueMode == automation.IssueModeIssue {
		return runner.runAgentOnIssue(ctx, call, spec)
	}
	return runner.askAgent(ctx, call, spec)
}

// resolveAgent finds the agent a spec names, by id or by capability.
func (runner *Runner) resolveAgent(ctx context.Context, call stepCall, spec agentSpec) (AgentRef, error) {
	if runner.options.Agents == nil {
		return AgentRef{}, stepFailure("EXECUTOR_UNAVAILABLE", "Agents are not configured.")
	}
	if spec.AgentID != "" {
		return runner.resolveAgentID(ctx, call, spec.AgentID)
	}
	if len(spec.RequiredCapabilities) > 0 {
		agent, err := runner.options.Agents.FindByCapabilities(ctx, call.run.WorkspaceID, spec.RequiredCapabilities)
		if err != nil {
			return AgentRef{}, wrapFailure("AGENT_NOT_FOUND", "No available agent has the required capabilities.", err)
		}
		return agent, nil
	}
	return AgentRef{}, stepFailure("AGENT_NOT_FOUND", "The step names no agent and no capabilities.")
}

// askAgent sends one bounded message and consumes the reply. The call is
// unsafe and attempted exactly once; its usage is recorded whether or not
// the reply was usable.
func (runner *Runner) askAgent(ctx context.Context, call stepCall, spec agentSpec) (automation.StepOutcome, error) {
	if runner.options.Responder == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "The agent runtime is not configured.")
	}
	agent, err := runner.resolveAgent(ctx, call, spec)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	instruction, err := render(spec.Instruction, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	input, err := resolveInput(spec.Input, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	message, err := agentMessage(instruction, input, spec.OutputSchema)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	runner.recordAgentEvent(ctx, call, agent.ID, "agent.started", nil)
	callCtx, cancel := context.WithTimeout(ctx, runner.options.InlineAgentTimeout)
	defer cancel()
	senderID := "berry-workflow:" + call.run.ID.String()
	senderName := "Berry Workflows"
	reply, err := runner.options.Responder.SendAgentMessage(callCtx, agent.UpstreamID, openfang.MessageRequest{
		Message:    message,
		SenderID:   &senderID,
		SenderName: &senderName,
		RequestID:  "automation:" + call.run.ID.String() + ":" + call.step.ID,
	})
	if err != nil {
		failure := wrapFailure("AGENT_CALL_FAILED", "The agent did not answer.", err)
		runner.recordAgentEvent(ctx, call, agent.ID, "agent.failed", &automationrepo.Failure{Code: failure.Code, Message: failure.Message})
		return automation.StepOutcome{}, failure
	}
	usage := &automation.Usage{
		InputTokens:       reply.InputTokens,
		OutputTokens:      reply.OutputTokens,
		UpstreamRequestID: reply.RequestID,
	}
	if reply.CostUSD > 0 {
		micros := int64(math.Round(reply.CostUSD * 1_000_000))
		usage.CostMicros = &micros
		usage.Currency = "USD"
	}
	output := map[string]any{
		"agentId":    agent.ID.String(),
		"agentName":  agent.Name,
		"response":   reply.Response,
		"iterations": reply.Iterations,
	}
	if len(spec.OutputSchema) > 0 {
		parsed, err := parseAgentJSON(reply.Response)
		if err != nil {
			failure := &StepError{Code: "AGENT_OUTPUT_INVALID", Message: "The agent did not answer with JSON.", Usage: usage, Err: err}
			runner.recordAgentEvent(ctx, call, agent.ID, "agent.failed", &automationrepo.Failure{Code: failure.Code, Message: failure.Message})
			return automation.StepOutcome{}, failure
		}
		if err := checkSchema(parsed, rawObject(spec.OutputSchema), ""); err != nil {
			failure := &StepError{Code: "AGENT_OUTPUT_INVALID", Message: "The agent's answer does not match the output schema: " + err.Error(), Usage: usage, Err: err}
			runner.recordAgentEvent(ctx, call, agent.ID, "agent.failed", &automationrepo.Failure{Code: failure.Code, Message: failure.Message})
			return automation.StepOutcome{}, failure
		}
		output["result"] = parsed
	}
	runner.recordAgentEvent(ctx, call, agent.ID, "agent.completed", nil)
	outcome := succeeded(output)
	outcome.Usage = usage
	return outcome, nil
}

// runAgentOnIssue creates an issue for the agent and admits its run, then
// waits for the run to end. The run ends at stream EOF after the runtime's
// terminal phase (run.completed) or without it (run.failed RUN_INCOMPLETE);
// the per-turn done event is never what settles the step.
func (runner *Runner) runAgentOnIssue(ctx context.Context, call stepCall, spec agentSpec) (automation.StepOutcome, error) {
	if runner.options.IssueRuns == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issue runs are not configured.")
	}
	agent, err := runner.resolveAgent(ctx, call, spec)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	instruction, err := render(spec.Instruction, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	input, err := resolveInput(spec.Input, call.scope)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	description := instruction
	if len(input) > 0 {
		encoded, _ := json.MarshalIndent(input, "", "  ")
		description += "\n\nInput (JSON):\n" + string(encoded)
	}
	if len(description) > maxAgentMessageBytes {
		return automation.StepOutcome{}, stepFailure("AGENT_MESSAGE_TOO_LARGE", "The instruction and input exceed the 64 KiB message limit.")
	}
	issue, err := runner.createIssue(ctx, call, issueSpec{
		Title:         issueTitle(instruction, call.step.ID),
		Description:   description,
		AssignAgentID: agent.ID.String(),
	})
	if err != nil {
		return automation.StepOutcome{}, err
	}
	return runner.admitRun(ctx, call, issue.ID, agent.ID, instruction)
}

// admitRun starts an agent run on an issue and parks the step on it.
func (runner *Runner) admitRun(ctx context.Context, call stepCall, issueID, agentID uuid.UUID, instructions string) (automation.StepOutcome, error) {
	if runner.options.IssueRuns == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issue runs are not configured.")
	}
	requester, err := actor(call)
	if err != nil {
		return automation.StepOutcome{}, err
	}
	params := runs.AdmitParams{
		RunID:          runner.options.NewID(),
		CreatedEventID: runner.options.NewID(),
		AssignmentID:   runner.options.NewID(),
		IssueRef:       issueID.String(),
		WorkspaceID:    call.run.WorkspaceID,
		AgentID:        &agentID,
		RequestedBy:    requester,
		RequestID:      "automation:" + call.run.ID.String() + ":" + call.step.ID,
		CreatedAt:      runner.now(),
	}
	if strings.TrimSpace(instructions) != "" {
		params.Instructions = &instructions
	}
	run, err := runner.options.IssueRuns.Admit(ctx, params)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("AGENT_RUN_REFUSED", "The agent run was not admitted.", err)
	}
	if err := runner.options.IssueRuns.Queue(run.ID); err != nil {
		return automation.StepOutcome{}, wrapFailure("AGENT_RUN_REFUSED", "The agent run was admitted but could not be queued.", err)
	}
	outcome := waiting("run:"+run.ID.String(), map[string]any{"runId": run.ID, "issueId": issueID, "agentId": agentID})
	outcome.Links.IssueRunID = &run.ID
	outcome.Links.IssueID = &issueID
	return outcome, nil
}

// runOutcome is the step output once an agent run completed: the run's
// result text and the artifacts it produced.
func (runner *Runner) runOutcome(ctx context.Context, runID uuid.UUID) (automation.StepOutcome, error) {
	if runner.options.IssueRuns == nil {
		return automation.StepOutcome{}, stepFailure("EXECUTOR_UNAVAILABLE", "Issue runs are not configured.")
	}
	run, err := runner.options.IssueRuns.Get(ctx, runID)
	if err != nil {
		return automation.StepOutcome{}, wrapFailure("AGENT_RUN_FAILED", "The agent run could not be read.", err)
	}
	switch run.Status {
	case runs.StatusFailed:
		code := "AGENT_RUN_FAILED"
		message := "The agent run failed."
		if run.Failure != nil {
			message = "The agent run failed (" + run.Failure.Code + ")."
		}
		return automation.StepOutcome{}, stepFailure(code, message)
	case runs.StatusCancelled:
		return automation.StepOutcome{}, stepFailure("AGENT_RUN_CANCELLED", "The agent run was cancelled.")
	case runs.StatusSucceeded:
	default:
		return automation.StepOutcome{}, stepFailure("AGENT_RUN_FAILED", "The agent run has not finished.")
	}
	output := map[string]any{
		"runId":   run.ID.String(),
		"issueId": run.IssueID.String(),
		"agentId": run.AgentID.String(),
		"result":  "",
		"usage": map[string]any{
			"inputTokens": run.Usage.InputTokens, "outputTokens": run.Usage.OutputTokens, "costMicros": run.Usage.CostMicros,
		},
		"artifacts": []map[string]any{},
	}
	if run.Summary != nil {
		output["result"] = *run.Summary
	}
	if runner.options.Issues != nil {
		if issue, err := runner.options.Issues.GetIssue(ctx, run.IssueID.String()); err == nil {
			output["identifier"] = issue.Identifier()
		}
	}
	if runner.options.Artifacts != nil {
		artifacts, err := runner.options.Artifacts.ListRunArtifacts(ctx, run.ID, nil, 100)
		if err == nil {
			output["artifacts"] = artifactRefs(artifacts)
		}
	}
	outcome := succeeded(output)
	outcome.Links.IssueRunID = &run.ID
	outcome.Links.IssueID = &run.IssueID
	return outcome, nil
}

func artifactRefs(artifacts []collaboration.Attachment) []map[string]any {
	refs := make([]map[string]any, 0, len(artifacts))
	for _, artifact := range artifacts {
		refs = append(refs, map[string]any{
			"id": artifact.ID.String(), "name": artifact.FileName, "contentType": artifact.ContentType, "sizeBytes": artifact.SizeBytes,
		})
	}
	return refs
}

func (runner *Runner) recordAgentEvent(ctx context.Context, call stepCall, agentID uuid.UUID, topic string, failure *automationrepo.Failure) {
	event, err := runner.options.Store.RecordAgentEvent(ctx, automationrepo.AgentEventParams{
		WorkspaceID: call.run.WorkspaceID, AgentID: agentID, RunID: call.run.ID, StepID: call.step.ID,
		Topic: topic, Failure: failure, OccurredAt: runner.now(), NewID: runner.options.NewID,
	})
	if err != nil {
		runner.options.Logger.Warn("agent event not recorded", "runId", call.run.ID, "stepId", call.step.ID, "topic", topic, "error", err)
		return
	}
	runner.publish(ctx, event)
}

// agentMessage is the instruction, the resolved input and, when the step
// expects structured output, the schema the reply must match.
func agentMessage(instruction string, input map[string]any, schema json.RawMessage) (string, error) {
	var builder strings.Builder
	builder.WriteString(strings.TrimSpace(instruction))
	if len(input) > 0 {
		encoded, err := json.MarshalIndent(input, "", "  ")
		if err != nil {
			return "", wrapFailure("INPUT_INVALID", "The input cannot be encoded.", err)
		}
		builder.WriteString("\n\nInput (JSON):\n")
		builder.Write(encoded)
	}
	if len(schema) > 0 {
		builder.WriteString("\n\nAnswer with a single JSON value matching this JSON Schema and nothing else:\n")
		builder.Write(schema)
	}
	message := builder.String()
	if len(message) > maxAgentMessageBytes {
		return "", stepFailure("AGENT_MESSAGE_TOO_LARGE", "The instruction and input exceed the 64 KiB message limit.")
	}
	return message, nil
}

// parseAgentJSON reads the JSON an agent answered with, tolerating a code
// fence or prose around it.
func parseAgentJSON(text string) (any, error) {
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "```") {
		text = strings.TrimPrefix(text, "```json")
		text = strings.TrimPrefix(text, "```")
		text = strings.TrimSuffix(text, "```")
		text = strings.TrimSpace(text)
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err == nil {
		return value, nil
	}
	start := strings.IndexAny(text, "{[")
	end := strings.LastIndexAny(text, "}]")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("no JSON value in the reply")
	}
	if err := json.Unmarshal([]byte(text[start:end+1]), &value); err != nil {
		return nil, err
	}
	return value, nil
}

// checkSchema applies the part of a JSON Schema a step can settle without
// a full validator: the value's type, required properties, and the types of
// declared properties and items, recursively.
func checkSchema(value any, schema map[string]any, path string) error {
	if schema == nil {
		return nil
	}
	if path == "" {
		path = "$"
	}
	if typed, ok := schema["type"].(string); ok {
		if err := checkType(value, typed, path); err != nil {
			return err
		}
	}
	if object, ok := value.(map[string]any); ok {
		if required, ok := schema["required"].([]any); ok {
			for _, entry := range required {
				name, _ := entry.(string)
				if _, present := object[name]; name != "" && !present {
					return fmt.Errorf("%s.%s is required", path, name)
				}
			}
		}
		if properties, ok := schema["properties"].(map[string]any); ok {
			for name, raw := range properties {
				nested, ok := raw.(map[string]any)
				child, present := object[name]
				if !ok || !present {
					continue
				}
				if err := checkSchema(child, nested, path+"."+name); err != nil {
					return err
				}
			}
		}
	}
	if items, ok := value.([]any); ok {
		if nested, ok := schema["items"].(map[string]any); ok {
			for index, item := range items {
				if err := checkSchema(item, nested, fmt.Sprintf("%s[%d]", path, index)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func checkType(value any, typed, path string) error {
	ok := true
	switch typed {
	case "object":
		_, ok = value.(map[string]any)
	case "array":
		_, ok = value.([]any)
	case "string":
		_, ok = value.(string)
	case "number":
		_, ok = value.(float64)
	case "integer":
		number, isNumber := value.(float64)
		ok = isNumber && number == math.Trunc(number)
	case "boolean":
		_, ok = value.(bool)
	case "null":
		ok = value == nil
	}
	if !ok {
		return fmt.Errorf("%s is not a %s", path, typed)
	}
	return nil
}

// issueTitle is the first line of the instruction, bounded, or a name
// derived from the step when the instruction starts with a blank line.
func issueTitle(instruction, stepID string) string {
	first := strings.TrimSpace(strings.SplitN(strings.TrimSpace(instruction), "\n", 2)[0])
	if first == "" {
		return "Agent task: " + stepID
	}
	if len(first) > 200 {
		first = bounded(first[:200])
	}
	return first
}
