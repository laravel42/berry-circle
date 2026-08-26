// Package prompts holds the versioned system prompts of Berry's model roles.
// Each file is one role's whole instruction set; the user message carries
// the task and its JSON context. A change of wording is a new file and a
// new version, recorded on the role agent and on every planner_events row
// the version produced.
package prompts

import (
	_ "embed"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

//go:embed intent-v2.md
var intentV2 string

//go:embed planner-v1.md
var plannerV1 string

//go:embed repair-v1.md
var repairV1 string

//go:embed critic-v1.md
var criticV1 string

// Role names, spelled the way model_role_agents.role stores them.
const (
	RoleClassifier = "classifier"
	RolePlanner    = "planner"
	RoleRepair     = "repair"
	RoleCritic     = "critic"
)

// Prompt is one role's system prompt.
type Prompt struct {
	Role    string
	Version string
	Text    string
}

const (
	placeholderPlanSchema   = "<<BERRY_PLAN_SCHEMA>>"
	placeholderIntentSchema = "<<INTENT_SCHEMA>>"
	placeholderCriticSchema = "<<CRITIC_SCHEMA>>"
)

func render(text string) string {
	replacer := strings.NewReplacer(
		placeholderPlanSchema, ir.PlanSchemaJSON,
		placeholderIntentSchema, ir.IntentSchemaJSON,
		placeholderCriticSchema, ir.CriticSchemaJSON,
	)
	return strings.TrimSpace(replacer.Replace(text))
}

// Classifier is the intent extraction prompt.
func Classifier() Prompt {
	return Prompt{Role: RoleClassifier, Version: "intent-v2", Text: render(intentV2)}
}

// Planner is the plan generation prompt.
func Planner() Prompt {
	return Prompt{Role: RolePlanner, Version: "planner-v1", Text: render(plannerV1)}
}

// Repair is the bounded repair prompt.
func Repair() Prompt {
	return Prompt{Role: RoleRepair, Version: "repair-v1", Text: render(repairV1)}
}

// Critic is the review prompt.
func Critic() Prompt {
	return Prompt{Role: RoleCritic, Version: "critic-v1", Text: render(criticV1)}
}

// All lists every role prompt in provisioning order.
func All() []Prompt {
	return []Prompt{Classifier(), Planner(), Repair(), Critic()}
}

// ForRole returns the prompt of one role.
func ForRole(role string) (Prompt, bool) {
	for _, prompt := range All() {
		if prompt.Role == role {
			return prompt, true
		}
	}
	return Prompt{}, false
}
