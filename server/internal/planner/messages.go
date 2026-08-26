package planner

import (
	"encoding/json"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
)

// The user messages the roles receive. Each is one bounded text: the
// request, the JSON the stage needs and a short instruction. The system
// prompt on the role agent carries the schema and the rules, so nothing
// here repeats them. When a message would exceed the runtime's one-message
// bound the context is compacted before the mandatory parts are refused.

const maxMessageBytes = openfang.MaxChatContentBytes

func section(title, body string) string {
	return "# " + title + "\n" + strings.TrimSpace(body) + "\n\n"
}

func encode(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func hintText(hint Hint) string {
	switch hint {
	case HintIssue:
		return "The person expects finite work: prefer issues and add workflows only for clearly repeatable processes."
	case HintWorkflow:
		return "The person expects automation: prefer a workflow and add issues only for finite set-up work it needs."
	}
	return "Decide between issues and workflows from the classification rules."
}

// intentMessage is the classifier's task.
func intentMessage(prompt string, hint Hint) string {
	var builder strings.Builder
	builder.WriteString(section("Request", prompt))
	builder.WriteString(section("Instructions", "Extract the intent of the request. "+hintText(hint)+" Return only the IntentAnalysis JSON object."))
	return strings.TrimSpace(builder.String())
}

// generateMessage is the planner's task: intent, context and the request.
func generateMessage(prompt string, intent ir.IntentAnalysis, rendered PlanContext) (string, error) {
	assumptions := make([]string, 0, len(intent.Ambiguities))
	for _, ambiguity := range intent.Ambiguities {
		if !ambiguity.Blocking {
			assumptions = append(assumptions, ambiguity.ID+": "+ambiguity.Description)
		}
	}
	instructions := "Produce the BerryPlan v1 for this request using only what the context lists. " + hintText(rendered.hint())
	if len(assumptions) > 0 {
		instructions += " Record these assumptions in `assumptions` (userEditable true, blocking false): " + strings.Join(assumptions, "; ") + "."
	}
	instructions += " Return only the JSON object."
	build := func(context PlanContext) string {
		var builder strings.Builder
		builder.WriteString(section("Request", prompt))
		builder.WriteString(section("Intent analysis", encode(intent)))
		builder.WriteString(section("Context", encode(context)))
		builder.WriteString(section("Instructions", instructions))
		return strings.TrimSpace(builder.String())
	}
	return fit(rendered, build)
}

// repairInput is the reduced context the repair role sees: what exists,
// not what it looks like.
type repairInput struct {
	Agents      []AgentCandidate    `json:"agents"`
	Tools       []toolName          `json:"tools"`
	Connections []ConnectionSummary `json:"connections"`
	Events      []string            `json:"events"`
}

type toolName struct {
	Name           string   `json:"name"`
	Kind           string   `json:"kind"`
	RequiredInputs []string `json:"requiredInputs"`
	Inputs         []string `json:"inputs"`
}

func reduce(rendered PlanContext) repairInput {
	out := repairInput{Agents: rendered.Agents, Connections: rendered.Connections, Events: rendered.Events, Tools: []toolName{}}
	if out.Agents == nil {
		out.Agents = []AgentCandidate{}
	}
	if out.Connections == nil {
		out.Connections = []ConnectionSummary{}
	}
	for _, tool := range rendered.Tools {
		out.Tools = append(out.Tools, toolName{Name: tool.Name, Kind: tool.Kind, RequiredInputs: tool.RequiredInputs, Inputs: tool.Inputs})
	}
	return out
}

// repairMessage is the repair role's task: the plan and the exact errors.
func repairMessage(prompt string, intent ir.IntentAnalysis, plan *ir.Plan, findings []ir.Finding, rendered PlanContext) (string, error) {
	planText := "(no schema-conforming plan was produced; write a complete plan)"
	if plan != nil {
		planText = encode(plan)
	}
	errors := ir.Errors(findings)
	if errors == nil {
		errors = []ir.Finding{}
	}
	build := func(context PlanContext) string {
		var builder strings.Builder
		builder.WriteString(section("Request", prompt))
		builder.WriteString(section("Intent analysis", encode(intent)))
		builder.WriteString(section("Current plan", planText))
		builder.WriteString(section("Validator errors", encode(errors)))
		builder.WriteString(section("Available", encode(reduce(context))))
		builder.WriteString(section("Instructions", "Repair the plan without changing the user's objective. Do not invent unavailable tools, agents, connections, or capabilities. Return the full corrected plan as one JSON object."))
		return strings.TrimSpace(builder.String())
	}
	return fit(rendered, build)
}

// criticMessage is the critic's task: the request, the intent and the plan.
func criticMessage(prompt string, intent ir.IntentAnalysis, plan ir.Plan, report validate.Report, rendered PlanContext) (string, error) {
	warnings := report.Warnings
	if warnings == nil {
		warnings = []ir.Finding{}
	}
	build := func(context PlanContext) string {
		var builder strings.Builder
		builder.WriteString(section("Request", prompt))
		builder.WriteString(section("Intent analysis", encode(intent)))
		builder.WriteString(section("Plan", encode(plan)))
		builder.WriteString(section("Validator warnings", encode(warnings)))
		builder.WriteString(section("Existing", encode(map[string]any{
			"issues": context.ExistingIssues, "workflows": context.ExistingWorkflows, "connections": context.Connections,
		})))
		builder.WriteString(section("Instructions", "Review the plan against the nine questions and return only the CriticVerdict JSON object."))
		return strings.TrimSpace(builder.String())
	}
	return fit(rendered, build)
}

// fit renders a message, compacting the context in steps until it fits the
// one-message bound. When the mandatory parts alone are too large the call
// is refused rather than truncated.
func fit(rendered PlanContext, build func(PlanContext) string) (string, error) {
	message := build(rendered)
	for level := 1; len(message) > maxMessageBytes && level <= 4; level++ {
		message = build(compact(rendered, level))
	}
	if len(message) > maxMessageBytes {
		return "", modelgateway.ErrRequestTooLarge
	}
	return message, nil
}

// compact drops context in the budget order: repository, existing issues,
// tool descriptions and outputs, then everything but agents and tool names.
func compact(rendered PlanContext, level int) PlanContext {
	out := rendered
	if level >= 1 {
		out.Repository = ""
	}
	if level >= 2 {
		out.ExistingIssues = []IssueSummary{}
		out.ExistingGoals = []GoalSummary{}
	}
	if level >= 3 {
		tools := make([]ToolSummary, 0, len(out.Tools))
		for _, tool := range out.Tools {
			tool.Description = ""
			tool.Outputs = []string{}
			tools = append(tools, tool)
		}
		out.Tools = tools
	}
	if level >= 4 {
		out.ExistingWorkflows = []WorkflowSummary{}
		out.Policies = []PolicySummary{}
		out.Events = []string{}
	}
	return out
}

func (rendered PlanContext) hint() Hint {
	return Hint(rendered.Hint)
}
