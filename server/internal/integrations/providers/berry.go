package providers

import (
	"sort"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

// Berry is Berry's own provider (spec §19): the events a workflow can start
// on and the operations a step can perform against Berry's product state.
//
// It needs no connection — Berry executes these itself, against the same
// repositories the HTTP routes use — so a workflow over Berry tools alone
// validates and activates with nothing connected. Only the declarations live
// here; the native executors arrive with workflow execution (P1b), and the
// same operations ship later as the Activepieces piece calling the REST
// routes.
type Berry struct{}

// ProviderBerry is the id used in tool names, definitions and the database.
const ProviderBerry = "berry"

func (Berry) ID() string   { return ProviderBerry }
func (Berry) Name() string { return "Berry" }
func (Berry) Description() string {
	return "Issues, goals, agents, approvals and artifacts inside this workspace."
}

// Scopes is empty: there is no OAuth flow for Berry itself.
func (Berry) Scopes() []string { return nil }

// berryTriggers maps each trigger operation to the outbox topic it fires on.
// issue_status_changed is issue.updated narrowed by the executor to changes
// that touched status, which is why it maps to the broad topic here.
var berryTriggers = map[string]string{
	"issue_created":        "issue.created",
	"issue_updated":        "issue.updated",
	"issue_assigned":       "issue.assigned",
	"issue_status_changed": "issue.updated",
	"issue_completed":      "issue.completed",
	"goal_started":         "goal.started",
	"goal_completed":       "goal.completed",
	"agent_started":        "agent.started",
	"agent_completed":      "agent.completed",
	"agent_failed":         "agent.failed",
	"approval_approved":    "approval.approved",
	"approval_rejected":    "approval.rejected",
	"artifact_created":     "artifact.created",
}

var berryTriggerDescriptions = map[string]string{
	"issue_created":        "An issue was created on a board.",
	"issue_updated":        "An issue changed.",
	"issue_assigned":       "An issue was assigned to a person or an agent.",
	"issue_status_changed": "An issue moved to another status.",
	"issue_completed":      "An issue reached done.",
	"goal_started":         "A goal started.",
	"goal_completed":       "A goal completed.",
	"agent_started":        "An agent started working.",
	"agent_completed":      "An agent finished its work.",
	"agent_failed":         "An agent failed.",
	"approval_approved":    "An approval was granted.",
	"approval_rejected":    "An approval was refused.",
	"artifact_created":     "A run produced an artifact.",
}

// BerryTriggerTopic returns the outbox topic a Berry trigger operation
// subscribes to.
func BerryTriggerTopic(operation string) (string, bool) {
	topic, ok := berryTriggers[operation]
	return topic, ok
}

// BerryTriggerOperations lists the trigger operations one outbox topic
// satisfies, sorted, so the dispatcher can match integration triggers on
// Berry's own provider the way it matches Berry event triggers.
func BerryTriggerOperations(topic string) []string {
	var operations []string
	for operation, subscribed := range berryTriggers {
		if subscribed == topic {
			operations = append(operations, operation)
		}
	}
	sort.Strings(operations)
	return operations
}

// BerryTriggerMatches reports whether a published fact satisfies a Berry
// trigger operation beyond its topic: issue_status_changed is issue.updated
// narrowed to changes that touched status.
func BerryTriggerMatches(operation string, payload map[string]any) bool {
	if operation != "issue_status_changed" {
		return true
	}
	changed, _ := payload["changedFields"].([]any)
	for _, field := range changed {
		if field == "status" {
			return true
		}
	}
	return false
}

// Tools lists every trigger and action. Triggers are reads; actions are
// classified like any other provider's so the permission model and the
// workflow validator treat them the same way.
func (Berry) Tools() []core.Tool {
	operations := make([]string, 0, len(berryTriggers))
	for operation := range berryTriggers {
		operations = append(operations, operation)
	}
	sort.Strings(operations)
	tools := make([]core.Tool, 0, len(operations)+18)
	for _, operation := range operations {
		tools = append(tools, native("berry."+operation, berryTriggerDescriptions[operation], core.EffectRead, core.ToolTrigger,
			map[string]any{"type": "object", "properties": map[string]any{
				"topic": map[string]any{"type": "string", "const": berryTriggers[operation]},
			}}))
	}
	tools = append(tools,
		native("berry.create_issue", "Create an issue on a board.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"title"}, "title", "description", "boardId", "assignAgentId", "priority", "goalId")),
		native("berry.update_issue", "Change an issue's title, description, status, priority or assignee.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue"}, "issue", "title", "description", "status", "priority", "assignAgentId")),
		native("berry.assign_issue", "Assign an issue to a person or an agent.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue", "assigneeType", "assigneeId"}, "issue", "assigneeType", "assigneeId")),
		native("berry.move_issue", "Move an issue to another status.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue", "status"}, "issue", "status")),
		// The human review gate stays: complete_issue only moves in_review to
		// done and only when the run's requester may.
		native("berry.complete_issue", "Mark a reviewed issue done.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue"}, "issue")),
		native("berry.create_goal", "Create a goal.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"title"}, "title", "description", "projectId")),
		native("berry.update_goal", "Change a goal's title, description or status.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"goalId"}, "goalId", "title", "description", "status")),
		native("berry.run_agent", "Start an agent on an issue.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue", "agentId"}, "issue", "agentId", "instructions")),
		native("berry.wait_for_agent", "Wait until an agent run completes.", core.EffectRead, core.ToolAction,
			objectSchema([]string{"runId"}, "runId")),
		native("berry.ask_agent", "Ask an agent one bounded question.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"agentId", "instruction"}, "agentId", "instruction", "input", "outputSchema")),
		native("berry.request_approval", "Ask a person to decide before continuing.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"title"}, "title", "description", "approverUserId", "approverRole", "timeout")),
		native("berry.wait_for_approval", "Wait until an approval is resolved.", core.EffectRead, core.ToolAction,
			objectSchema([]string{"approvalId"}, "approvalId")),
		native("berry.add_comment", "Comment on an issue.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue", "body"}, "issue", "body")),
		native("berry.attach_artifact", "Attach a file to an issue.", core.EffectWrite, core.ToolAction,
			objectSchema([]string{"issue", "name", "content"}, "issue", "name", "content", "contentType")),
		native("berry.search_issues", "Find issues by text and filters.", core.EffectRead, core.ToolAction,
			objectSchema(nil, "query", "boardId", "status", "assigneeId")),
		native("berry.get_issue", "Read one issue.", core.EffectRead, core.ToolAction,
			objectSchema([]string{"issue"}, "issue")),
		native("berry.get_goal", "Read one goal with its progress.", core.EffectRead, core.ToolAction,
			objectSchema([]string{"goalId"}, "goalId")),
	)
	return withProvider(ProviderBerry, tools)
}

// MCPServer is empty: nothing runs Berry's tools but Berry.
func (Berry) MCPServer(string) core.MCPServerConfig {
	return core.MCPServerConfig{}
}

func native(name, description string, effect core.Effect, kind core.ToolKind, input map[string]any) core.Tool {
	return core.Tool{
		Name:               name,
		Description:        description,
		Effect:             effect,
		Kind:               kind,
		EnabledByDefault:   true,
		ConnectionRequired: false,
		InputSchema:        input,
	}
}

func objectSchema(required []string, properties ...string) map[string]any {
	props := make(map[string]any, len(properties))
	for _, property := range properties {
		props[property] = map[string]any{"type": "string"}
	}
	schema := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		list := make([]any, 0, len(required))
		for _, name := range required {
			list = append(list, name)
		}
		schema["required"] = list
	}
	return schema
}
