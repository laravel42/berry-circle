package validate

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

// credentialPatterns recognise token-like literals. A plan carries
// connection ids and non-secret metadata, never credentials; a match means
// the model echoed a secret from the prompt or invented one.
var credentialPatterns = []*regexp.Regexp{
	regexp.MustCompile(`\bsk_(?:live|test)_[A-Za-z0-9]{8,}`),
	regexp.MustCompile(`\brk_(?:live|test)_[A-Za-z0-9]{8,}`),
	regexp.MustCompile(`\bghp_[A-Za-z0-9]{20,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{20,}`),
	regexp.MustCompile(`\bxox[abpr]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`),
	regexp.MustCompile(`\b[0-9a-fA-F]{32,}\b`),
	regexp.MustCompile(`(?i)\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}`),
}

// LooksLikeCredential reports whether text carries a token-like literal.
func LooksLikeCredential(text string) bool {
	for _, pattern := range credentialPatterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return false
}

func checkCredential(path, text string, report *Report) {
	if text != "" && LooksLikeCredential(text) {
		report.hint(path, CodeCredentialLeak, "The text contains something that looks like a credential.",
			"Remove the secret; reference the workspace connection instead.", automation.SeverityError)
	}
}

func checkSafety(input Input, report *Report) {
	plan := input.Plan
	gated := approvalTargets(plan)
	for index, issue := range plan.Issues {
		path := "/issues/" + strconv.Itoa(index)
		if policy, ok := integrationcore.MatchPolicy(issueText(issue)); ok && !issue.RequiresApproval && !gated["issue:"+issue.TempID] {
			report.hint(path, CodeDestructiveWithoutApproval,
				fmt.Sprintf("%s (policy %s) needs a human decision before an agent starts it.", policy.Description, policy.ID),
				"Set requiresApproval to true or add an approvals entry targeting this issue.", automation.SeverityError)
		}
		checkCredential(path+"/title", issue.Title, report)
		if issue.Description != nil {
			checkCredential(path+"/description", *issue.Description, report)
		}
	}
	for index, assumption := range plan.Assumptions {
		checkCredential("/assumptions/"+strconv.Itoa(index)+"/description", assumption.Description, report)
	}
	for index, approval := range plan.Approvals {
		if approval.Description != nil {
			checkCredential("/approvals/"+strconv.Itoa(index)+"/description", *approval.Description, report)
		}
	}
	for windex, workflow := range plan.Workflows {
		for sindex, step := range workflow.Steps {
			path := fmt.Sprintf("/workflows/%d/steps/%d", windex, sindex)
			switch {
			case step.Action != nil:
				checkCredential(path+"/input", rawText(step.Action.Input), report)
			case step.Agent != nil:
				checkCredential(path+"/instruction", step.Agent.Instruction, report)
				checkCredential(path+"/input", rawText(step.Agent.Input), report)
			case step.CreateIssue != nil:
				checkCredential(path+"/title", step.CreateIssue.Title, report)
				checkCredential(path+"/description", step.CreateIssue.Description, report)
			case step.Approval != nil:
				checkCredential(path+"/description", step.Approval.Description, report)
			}
		}
	}
	if input.Previous != nil {
		checkApprovalRemoved(*input.Previous, plan, report)
	}
}

func rawText(input map[string]json.RawMessage) string {
	if len(input) == 0 {
		return ""
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// checkApprovalRemoved refuses a revision that drops a mandatory approval:
// an issue the previous version gated by policy is still policy work, so
// the gate must stay, and a policy approvals entry may not vanish while its
// target remains.
func checkApprovalRemoved(previous, current ir.Plan, report *Report) {
	previousGates := approvalTargets(previous)
	previousIssues := map[string]ir.Issue{}
	for _, issue := range previous.Issues {
		previousIssues[issue.TempID] = issue
	}
	currentGates := approvalTargets(current)
	for index, issue := range current.Issues {
		before, existed := previousIssues[issue.TempID]
		if !existed {
			continue
		}
		wasGated := before.RequiresApproval || previousGates["issue:"+issue.TempID]
		isGated := issue.RequiresApproval || currentGates["issue:"+issue.TempID]
		if _, policy := integrationcore.MatchPolicy(issueText(issue)); wasGated && !isGated && policy {
			report.hint("/issues/"+strconv.Itoa(index), CodeApprovalRemoved, "The previous version required an approval for this issue; the planner cannot remove mandatory approvals.",
				"Restore requiresApproval or the approvals entry.", automation.SeverityError)
		}
	}
	currentItems := map[string]bool{}
	for _, workflow := range current.Workflows {
		currentItems["workflow:"+workflow.TempID] = true
		for _, step := range workflow.Steps {
			currentItems["step:"+workflow.TempID+"/"+step.ID] = true
		}
	}
	for _, approval := range previous.Approvals {
		if approval.Reason != "policy" {
			continue
		}
		key := approval.Target.Kind + ":" + approval.Target.TempID
		if approval.Target.Kind == "step" {
			key += "/" + approval.Target.StepID
		}
		if approval.Target.Kind == "issue" || !currentItems[key] || currentGates[approval.Target.Kind+":"+approval.Target.TempID] {
			continue
		}
		report.hint("/approvals", CodeApprovalRemoved, fmt.Sprintf("Policy approval %q is missing from this version while its target remains.", approval.Title),
			"Restore the approval.", automation.SeverityError)
	}
}
