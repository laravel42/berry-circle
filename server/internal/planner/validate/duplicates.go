package validate

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

var nonWordPattern = regexp.MustCompile(`[^a-z0-9]+`)

// Normalise lowercases a title and collapses everything that is not a
// letter or digit, the way the trigram comparison wants it.
func Normalise(text string) string {
	return strings.TrimSpace(nonWordPattern.ReplaceAllString(strings.ToLower(text), " "))
}

func trigrams(text string) map[string]bool {
	set := map[string]bool{}
	for _, word := range strings.Fields(text) {
		padded := "  " + word + " "
		for index := 0; index+3 <= len(padded); index++ {
			set[padded[index:index+3]] = true
		}
	}
	return set
}

// Similarity is the trigram Jaccard similarity of two normalised titles,
// the measure pg_trgm's similarity() uses.
func Similarity(left, right string) float64 {
	a, b := trigrams(Normalise(left)), trigrams(Normalise(right))
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	shared := 0
	for gram := range a {
		if b[gram] {
			shared++
		}
	}
	union := len(a) + len(b) - shared
	return float64(shared) / float64(union)
}

func workflowActions(workflow ir.Workflow) []string {
	var actions []string
	for _, step := range workflow.Steps {
		if step.Action != nil {
			actions = append(actions, step.Action.Provider+"."+step.Action.Operation)
		}
	}
	sort.Strings(actions)
	return actions
}

func sameActions(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	sorted := append([]string(nil), right...)
	sort.Strings(sorted)
	for index := range left {
		if left[index] != sorted[index] {
			return false
		}
	}
	return true
}

func sameTrigger(workflow ir.Workflow, existing ExistingWorkflow) bool {
	trigger := workflow.Trigger
	return string(trigger.Type) == existing.TriggerType && trigger.Provider == existing.TriggerProvider &&
		trigger.Operation == existing.TriggerOperation && trigger.Event == existing.TriggerEvent
}

func checkDuplicates(input Input, report *Report) {
	plan := input.Plan
	for index, issue := range plan.Issues {
		for _, existing := range input.ExistingIssues {
			if Similarity(issue.Title, existing.Title) >= SimilarityThreshold {
				report.hint("/issues/"+strconv.Itoa(index), CodeIssueSimilarExists,
					fmt.Sprintf("Open issue %s (%q) looks like the same work.", existing.Identifier, existing.Title),
					"Reference "+existing.Identifier+" instead of creating a duplicate, or explain the difference in the description.", automation.SeverityWarning)
				break
			}
		}
	}
	deployExists := ""
	for _, existing := range input.ExistingWorkflows {
		if existing.Status != "active" {
			continue
		}
		if policy, ok := integrationcore.MatchPolicy(existing.Name); ok && policy.ID == "deploy_production" {
			deployExists = existing.Name
		}
	}
	for index, workflow := range plan.Workflows {
		path := "/workflows/" + strconv.Itoa(index)
		actions := workflowActions(workflow)
		duplicate := false
		for _, existing := range input.ExistingWorkflows {
			if existing.Status != "active" || !sameTrigger(workflow, existing) {
				continue
			}
			if sameActions(actions, existing.Actions) {
				report.hint(path, CodeWorkflowDuplicate, fmt.Sprintf("Active workflow %q already has this trigger and these actions.", existing.Name),
					"Extend the existing workflow instead of creating another.", automation.SeverityWarning)
				duplicate = true
				break
			}
		}
		if !duplicate && workflow.Trigger.Type == automation.TriggerIntegration {
			for _, existing := range input.ExistingWorkflows {
				if existing.Status == "active" && sameTrigger(workflow, existing) {
					report.hint(path+"/trigger", CodeWebhookProcessorExist,
						fmt.Sprintf("Active workflow %q already consumes %s.%s.", existing.Name, workflow.Trigger.Provider, workflow.Trigger.Operation),
						"Consider adding the steps to the existing workflow.", automation.SeverityWarning)
					break
				}
			}
		}
		text := workflow.Name
		if workflow.Description != nil {
			text += "\n" + *workflow.Description
		}
		if policy, ok := integrationcore.MatchPolicy(text); ok && policy.ID == "deploy_production" && deployExists != "" {
			report.warnf(path, CodeDeployAutomationExist, fmt.Sprintf("Active workflow %q already automates production deployment.", deployExists))
		}
	}
}
