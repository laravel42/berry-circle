package validate

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

// codeWorkPattern recognises work that changes a repository or a deployment,
// which belongs on the board rather than inside a workflow step.
var codeWorkPattern = regexp.MustCompile(`(?i)\b(?:implement|refactor|repositor(?:y|ies)|repo\b|pull request|commit|branch|codebase|deploy|migration|compile|build the|write (?:the )?code|fix (?:the )?bug)`)

// repositoryWorkPattern recognises issues that need repository access.
var repositoryWorkPattern = regexp.MustCompile(`(?i)\b(?:repositor(?:y|ies)|repo\b|pull request|branch|commit|codebase|refactor|implement|integrate .* sdk|fix (?:the )?bug)`)

func indexAgents(agents []Agent) map[uuid.UUID]Agent {
	index := make(map[uuid.UUID]Agent, len(agents))
	for _, agent := range agents {
		index[agent.ID] = agent
	}
	return index
}

func agentHas(agent Agent, capability string) bool {
	for _, skill := range agent.Skills {
		if strings.EqualFold(skill, capability) {
			return true
		}
	}
	for _, tool := range agent.Tools {
		if strings.EqualFold(tool, capability) {
			return true
		}
	}
	return false
}

// checkAgentReference applies the agent rules to one reference: unknown or
// orchestrator agents are errors the repair role drops; a capability gap,
// an offline agent or a tight hourly cap are warnings the person sees.
func checkAgentReference(path string, agentID uuid.UUID, required []string, agents map[uuid.UUID]Agent, report *Report) {
	agent, ok := agents[agentID]
	if !ok {
		report.hint(path, CodeAgentUnknown, "No such agent in this workspace.", "Drop the suggestion and keep requiredCapabilities.", automation.SeverityError)
		return
	}
	if agent.Orchestrator {
		report.hint(path, CodeAgentOrchestratorSuggested, "The built-in orchestrator routes work; it does not take it.", "Drop the suggestion and keep requiredCapabilities.", automation.SeverityError)
		return
	}
	var missing []string
	for _, capability := range required {
		if !agentHas(agent, capability) {
			missing = append(missing, capability)
		}
	}
	if len(missing) > 0 {
		report.warnf(path, CodeAgentCapabilityMissing, fmt.Sprintf("Agent %q lacks %s.", agent.Name, strings.Join(missing, ", ")))
	}
	if agent.Status == "offline" {
		report.warnf(path, CodeAgentUnavailable, fmt.Sprintf("Agent %q is offline.", agent.Name))
	}
	if agent.MaxLLMTokensPerHour != nil && *agent.MaxLLMTokensPerHour < MinHourlyTokens {
		report.warnf(path, CodeAgentHourlyCap, fmt.Sprintf("Agent %q may spend at most %d LLM tokens per hour, which one issue can exceed.", agent.Name, *agent.MaxLLMTokensPerHour))
	}
}

func checkAgents(input Input, report *Report) {
	agents := indexAgents(input.Agents)
	for index, issue := range input.Plan.Issues {
		path := "/issues/" + strconv.Itoa(index)
		if issue.SuggestedAgentID != nil {
			checkAgentReference(path+"/suggestedAgentId", *issue.SuggestedAgentID, issue.RequiredCapabilities, agents, report)
		}
		if input.Workspace.HasProject && !input.Workspace.HasRepository && repositoryWorkPattern.MatchString(issueText(issue)) {
			report.warnf(path, CodeAgentRepositoryAccess, "The issue describes repository work but the project has no repository connected.")
		}
	}
	for windex, workflow := range input.Plan.Workflows {
		for sindex, step := range workflow.Steps {
			path := fmt.Sprintf("/workflows/%d/steps/%d", windex, sindex)
			switch {
			case step.Agent != nil:
				if step.Agent.AgentID != "" {
					if id, err := uuid.Parse(step.Agent.AgentID); err == nil {
						checkAgentReference(path+"/agentId", id, step.Agent.RequiredCapabilities, agents, report)
					}
				}
				mode := step.Agent.IssueMode
				if (mode == "" || mode == automation.IssueModeInline) && codeWorkPattern.MatchString(step.Agent.Instruction) {
					report.hint(path, CodeAgentStepShouldBeIssue, "The instruction describes code, repository or deployment work, which belongs on the board.",
						"Set issueMode to \"issue\" or replace the step with create_issue so the work is tracked.", automation.SeverityWarning)
				}
			case step.CreateIssue != nil && step.CreateIssue.AssignAgentID != "":
				if id, err := uuid.Parse(step.CreateIssue.AssignAgentID); err == nil {
					checkAgentReference(path+"/assignAgentId", id, nil, agents, report)
				}
			}
		}
	}
}

// approvalTargets indexes the plan's approvals by what they gate.
func approvalTargets(plan ir.Plan) map[string]bool {
	targets := map[string]bool{}
	for _, approval := range plan.Approvals {
		targets[approval.Target.Kind+":"+approval.Target.TempID] = true
	}
	return targets
}
