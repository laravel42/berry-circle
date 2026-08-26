package automation

import "sort"

// Risk is the indexed risk class of a workflow. Activating a high-risk
// workflow needs settings.write (D7).
type Risk string

const (
	RiskLow    Risk = "low"
	RiskMedium Risk = "medium"
	RiskHigh   Risk = "high"
)

// Metadata is what the automations row indexes beside the definition, derived
// on every write so a list or a trigger match never parses JSON.
type Metadata struct {
	TriggerType      TriggerType
	TriggerProvider  string
	TriggerOperation string
	TriggerEvent     string
	ScheduleCron     string
	ScheduleTimezone string
	Risk             Risk
	// Providers is every provider the workflow talks to, sorted, which is what
	// a required-connections list is built from.
	Providers []string
}

// DeriveMetadata reads the trigger and steps. Risk: a workflow that only
// observes is low; one that changes Berry state or calls a provider is
// medium; one whose tool the catalog marks destructive or approval-gated is
// high. Without a catalog every action is assumed medium.
func DeriveMetadata(definition Definition, catalog Catalog) Metadata {
	metadata := Metadata{
		TriggerType:      definition.Trigger.Type,
		TriggerProvider:  definition.Trigger.Provider,
		TriggerOperation: definition.Trigger.Operation,
		TriggerEvent:     definition.Trigger.Event,
		Risk:             RiskLow,
	}
	if definition.Trigger.Config != nil && definition.Trigger.Type == TriggerSchedule {
		metadata.ScheduleCron = definition.Trigger.Config.Cron
		metadata.ScheduleTimezone = definition.Trigger.Config.Timezone
	}
	providers := map[string]bool{}
	if definition.Trigger.Type == TriggerIntegration && definition.Trigger.Provider != "" {
		providers[definition.Trigger.Provider] = true
	}
	raise := func(level Risk) {
		if rank(level) > rank(metadata.Risk) {
			metadata.Risk = level
		}
	}
	for _, step := range definition.Steps {
		switch step.Type {
		case StepAction:
			if step.Action == nil {
				continue
			}
			raise(RiskMedium)
			if step.Action.Provider != "" {
				providers[step.Action.Provider] = true
			}
			if catalog != nil {
				if spec, ok := catalog.Tool(step.Action.Provider, step.Action.Operation, ToolAction); ok &&
					(spec.Destructive || spec.RequiresApproval) {
					raise(RiskHigh)
				}
			}
		case StepAgent, StepCreateIssue, StepUpdateIssue, StepSubworkflow:
			raise(RiskMedium)
		}
	}
	metadata.Providers = make([]string, 0, len(providers))
	for provider := range providers {
		metadata.Providers = append(metadata.Providers, provider)
	}
	sort.Strings(metadata.Providers)
	return metadata
}

func rank(level Risk) int {
	switch level {
	case RiskMedium:
		return 1
	case RiskHigh:
		return 2
	default:
		return 0
	}
}
