package automation

import (
	"reflect"
	"testing"
	"time"
)

func TestSampleDefinitionIsValidWithAndWithoutACatalog(t *testing.T) {
	t.Parallel()
	definition := parseSample(t)
	if report := ValidateDefinition(definition, ValidateOptions{}); !report.Valid() {
		t.Fatalf("structural validation failed: %v", codes(report.Errors))
	}
	report := ValidateDefinition(definition, ValidateOptions{Catalog: sampleCatalog()})
	if !report.Valid() {
		t.Fatalf("catalog validation failed: %v", codes(report.Errors))
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", codes(report.Warnings))
	}
}

// Every structural and workflow rule, one mutation each, asserted by code and
// JSON pointer so a handler can show the finding on the right field.
func TestStructuralAndWorkflowRules(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		edit func(document map[string]any)
		code string
		path string
	}{
		"unsupported version": {
			func(d map[string]any) { d["version"] = "0" }, "DEFINITION_VERSION_UNSUPPORTED", "/version"},
		"trigger type": {
			func(d map[string]any) { d["trigger"].(map[string]any)["type"] = "cron" }, "TRIGGER_TYPE_INVALID", "/trigger/type"},
		"unknown berry event": {
			func(d map[string]any) { d["trigger"].(map[string]any)["event"] = "issue.exploded" }, "BERRY_EVENT_UNKNOWN", "/trigger/event"},
		"schedule without cron": {
			func(d map[string]any) {
				d["trigger"] = map[string]any{"id": "tick", "type": "schedule", "config": map[string]any{"timezone": "Europe/Rome"}}
			}, "SCHEDULE_CRON_INVALID", "/trigger/config/cron"},
		"schedule with a bad timezone": {
			func(d map[string]any) {
				d["trigger"] = map[string]any{"id": "tick", "type": "schedule", "config": map[string]any{"cron": "0 9 * * 1", "timezone": "Mars/Olympus"}}
			}, "SCHEDULE_TIMEZONE_INVALID", "/trigger/config/timezone"},
		"integration trigger without operation": {
			func(d map[string]any) {
				d["trigger"] = map[string]any{"id": "pay", "type": "integration", "provider": "stripe"}
			},
			"STEP_FIELD_REQUIRED", "/trigger/operation"},
		"trigger filter reading a step": {
			func(d map[string]any) {
				d["trigger"].(map[string]any)["config"] = map[string]any{"filter": map[string]any{"op": "exists", "left": map[string]any{"ref": "steps.notify.output.x"}}}
			}, "OUTPUT_REF_INVALID", "/trigger/config/filter"},
		"empty entry": {
			func(d map[string]any) { d["entry"] = []any{} }, "WORKFLOW_ENTRY_INVALID", "/entry"},
		"entry naming a missing step": {
			func(d map[string]any) { d["entry"] = []any{"nope"} }, "WORKFLOW_ENTRY_INVALID", "/entry/0"},
		"invalid step id": {
			func(d map[string]any) { step(d, "pause")["id"] = "Pause-1" }, "STEP_ID_INVALID", "/steps/5/id"},
		"duplicate step id": {
			func(d map[string]any) { step(d, "pause")["id"] = "ticket" }, "STEP_ID_DUPLICATE", "/steps/5/id"},
		"step id equal to the trigger id": {
			func(d map[string]any) { step(d, "pause")["id"] = "on_done" }, "STEP_ID_DUPLICATE", "/steps/5/id"},
		"foreach body escaping through a dependency": {
			func(d map[string]any) {
				d["steps"] = append(steps(d),
					map[string]any{"id": "each", "type": "foreach", "items": map[string]any{"ref": "trigger.rows"}, "steps": []any{"pause"}, "dependsOn": []any{"ticket"}},
					map[string]any{"id": "after", "type": "wait", "mode": "duration", "duration": "PT1M", "dependsOn": []any{"pause"}})
			}, "FOREACH_BODY_ESCAPE", "/steps/7/dependsOn/0"},
		"dependsOn unknown step": {
			func(d map[string]any) { step(d, "pause")["dependsOn"] = []any{"ghost"} }, "STEP_REF_UNKNOWN", "/steps/5/dependsOn/0"},
		"branch to unknown step": {
			func(d map[string]any) { step(d, "check")["falseSteps"] = []any{"ghost"} }, "STEP_REF_UNKNOWN", "/steps/0/falseSteps/0"},
		"unreachable step": {
			func(d map[string]any) { delete(step(d, "pause"), "dependsOn") }, "STEP_UNREACHABLE", "/steps/5"},
		"cycle": {
			func(d map[string]any) { step(d, "notify")["dependsOn"] = []any{"deploy"} }, "STEP_GRAPH_CYCLE", ""},
		"reference to a step on another branch": {
			func(d map[string]any) { step(d, "ticket")["title"] = "{{ steps.notify.output.ts }}" }, "OUTPUT_REF_INVALID", "/steps/4/title"},
		"reference to an unknown step": {
			func(d map[string]any) {
				step(d, "deploy")["input"] = map[string]any{"x": map[string]any{"ref": "steps.ghost.output.a"}}
			}, "OUTPUT_REF_INVALID", "/steps/3/input/x"},
		"broken template": {
			func(d map[string]any) { step(d, "notify")["input"] = map[string]any{"text": "Hi {{ trigger.name"} }, "TEMPLATE_REF_INVALID", "/steps/1/input/text"},
		"condition operands": {
			func(d map[string]any) { step(d, "check")["expression"] = map[string]any{"op": "gte", "left": 1} }, "CONDITION_OPERANDS_INVALID", "/steps/0/expression"},
		"condition without branches": {
			func(d map[string]any) {
				step(d, "check")["trueSteps"] = []any{}
				delete(step(d, "check"), "falseSteps")
				d["entry"] = []any{"check", "notify", "ticket"}
			}, "STEP_FIELD_REQUIRED", "/steps/0/trueSteps"},
		"wait without duration": {
			func(d map[string]any) { delete(step(d, "pause"), "duration") }, "WAIT_MODE_INCOMPLETE", "/steps/5/duration"},
		"wait until with a bad instant": {
			func(d map[string]any) {
				step(d, "pause")["mode"] = "until"
				step(d, "pause")["until"] = "tomorrow"
			}, "WAIT_MODE_INCOMPLETE", "/steps/5/until"},
		"wait for an unknown berry event": {
			func(d map[string]any) {
				step(d, "pause")["mode"] = "event"
				step(d, "pause")["event"] = map[string]any{"provider": "berry", "event": "issue.vanished"}
			}, "BERRY_EVENT_UNKNOWN", "/steps/5/event/event"},
		"approval addressed to nobody": {
			func(d map[string]any) { step(d, "gate")["approver"] = map[string]any{"type": "role", "role": "ceo"} }, "APPROVAL_APPROVER_REQUIRED", "/steps/2/approver/role"},
		"approval with a bad timeout": {
			func(d map[string]any) { step(d, "gate")["timeout"] = "7 days" }, "STEP_FIELD_INVALID", "/steps/2/timeout"},
		"agent without instruction": {
			func(d map[string]any) {
				d["steps"] = append(steps(d), map[string]any{"id": "think", "type": "agent", "instruction": "", "dependsOn": []any{"ticket"}})
			}, "STEP_FIELD_REQUIRED", "/steps/6/instruction"},
		"agent with a bad issue mode": {
			func(d map[string]any) {
				d["steps"] = append(steps(d), map[string]any{"id": "think", "type": "agent", "instruction": "Summarise", "issueMode": "board", "dependsOn": []any{"ticket"}})
			}, "STEP_FIELD_INVALID", "/steps/6/issueMode"},
		"create_issue with a bad goal reference": {
			func(d map[string]any) { step(d, "ticket")["goalId"] = "{{ trigger.goal }}" }, "STEP_FIELD_INVALID", "/steps/4/goalId"},
		"create_issue with a bad priority": {
			func(d map[string]any) { step(d, "ticket")["priority"] = "critical" }, "STEP_FIELD_INVALID", "/steps/4/priority"},
		"update_issue with an empty patch": {
			func(d map[string]any) {
				d["steps"] = append(steps(d), map[string]any{"id": "close", "type": "update_issue", "issue": map[string]any{"ref": "steps.ticket.output.id"}, "patch": map[string]any{}, "dependsOn": []any{"ticket"}})
			}, "STEP_FIELD_REQUIRED", "/steps/6/patch"},
		"onError outside the vocabulary": {
			func(d map[string]any) { step(d, "notify")["onError"] = "retry" }, "STEP_FIELD_INVALID", "/steps/1/onError"},
		"too many steps": {
			func(d map[string]any) {
				list := steps(d)
				for index := 0; index < MaxSteps; index++ {
					list = append(list, map[string]any{"id": "w" + itoa(index), "type": "wait", "mode": "duration", "duration": "PT1M", "dependsOn": []any{"ticket"}})
				}
				d["steps"] = list
			}, "PLAN_TOO_LARGE", "/steps"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			report := ValidateDefinition(mutate(t, testCase.edit), ValidateOptions{})
			if !hasCode(report.Errors, testCase.code, testCase.path) {
				t.Fatalf("errors = %v, want %s@%s", codes(report.Errors), testCase.code, testCase.path)
			}
		})
	}
}

func itoa(value int) string {
	digits := "0123456789"
	if value < 10 {
		return string(digits[value])
	}
	return itoa(value/10) + string(digits[value%10])
}

// With a catalog the validator knows which tools exist, what they need, and
// which ones a person must approve. A missing connection only warns on a
// draft but blocks activation.
func TestCatalogRules(t *testing.T) {
	t.Parallel()
	catalog := sampleCatalog()

	report := ValidateDefinition(mutate(t, func(d map[string]any) { step(d, "notify")["operation"] = "send_dm" }),
		ValidateOptions{Catalog: catalog})
	if !hasCode(report.Errors, "TOOL_UNKNOWN", "/steps/1/operation") {
		t.Fatalf("unknown tool: %v", codes(report.Errors))
	}

	report = ValidateDefinition(mutate(t, func(d map[string]any) {
		step(d, "notify")["input"] = map[string]any{"channel": "#x", "emoji": ":tada:"}
	}), ValidateOptions{Catalog: catalog})
	if !hasCode(report.Errors, "INPUT_REQUIRED_MISSING", "/steps/1/input/text") ||
		!hasCode(report.Errors, "INPUT_UNKNOWN_PROPERTY", "/steps/1/input/emoji") {
		t.Fatalf("input schema: %v", codes(report.Errors))
	}

	report = ValidateDefinition(mutate(t, func(d map[string]any) { step(d, "deploy")["dependsOn"] = []any{"notify"} }),
		ValidateOptions{Catalog: catalog})
	if !hasCode(report.Errors, "DESTRUCTIVE_WITHOUT_APPROVAL", "/steps/3") {
		t.Fatalf("destructive action without an approval ancestor: %v", codes(report.Errors))
	}

	disconnected := sampleCatalog()
	disconnected.connected = map[string]bool{}
	report = ValidateDefinition(parseSample(t), ValidateOptions{Catalog: disconnected})
	if !report.Valid() || !hasCode(report.Warnings, "CONNECTION_MISSING", "/steps/1/provider") {
		t.Fatalf("draft with a missing connection: errors %v warnings %v", codes(report.Errors), codes(report.Warnings))
	}
	report = ValidateDefinition(parseSample(t), ValidateOptions{Catalog: disconnected, RequireConnections: true})
	if !hasCode(report.Errors, "CONNECTION_MISSING", "/steps/1/provider") {
		t.Fatalf("activation with a missing connection: %v", codes(report.Errors))
	}

	report = ValidateDefinition(mutate(t, func(d map[string]any) {
		d["trigger"] = map[string]any{"id": "pay", "type": "integration", "provider": "stripe", "operation": "refund_created"}
	}), ValidateOptions{Catalog: catalog})
	if !hasCode(report.Errors, "TRIGGER_UNKNOWN", "/trigger/operation") {
		t.Fatalf("unknown trigger: %v", codes(report.Errors))
	}
}

func TestDeriveMetadataIndexesTriggerProvidersAndRisk(t *testing.T) {
	t.Parallel()
	definition := parseSample(t)
	metadata := DeriveMetadata(definition, nil)
	if metadata.TriggerType != TriggerBerryEvent || metadata.TriggerEvent != "issue.completed" || metadata.Risk != RiskMedium {
		t.Fatalf("metadata without catalog = %+v", metadata)
	}
	if !reflect.DeepEqual(metadata.Providers, []string{"github", "slack"}) {
		t.Fatalf("providers = %v", metadata.Providers)
	}
	metadata = DeriveMetadata(definition, sampleCatalog())
	if metadata.Risk != RiskHigh {
		t.Fatalf("a destructive tool did not raise the risk: %+v", metadata)
	}
	scheduled := mutate(t, func(d map[string]any) {
		d["trigger"] = map[string]any{"id": "tick", "type": "schedule", "config": map[string]any{"cron": "0 9 * * 1", "timezone": "Europe/Rome"}}
		d["steps"] = []any{map[string]any{"id": "pause", "type": "wait", "mode": "duration", "duration": "PT1M"}}
		d["entry"] = []any{"pause"}
	})
	metadata = DeriveMetadata(scheduled, nil)
	if metadata.ScheduleCron != "0 9 * * 1" || metadata.ScheduleTimezone != "Europe/Rome" || metadata.Risk != RiskLow || len(metadata.Providers) != 0 {
		t.Fatalf("schedule metadata = %+v", metadata)
	}
}

func TestBerryEventVocabularyAcceptsAggregateWildcards(t *testing.T) {
	t.Parallel()
	for topic, want := range map[string]bool{
		"issue.completed": true, "issue.*": true, "approval.*": true, "issue.exploded": false, "*": false, "nope.*": false,
	} {
		if got := KnownBerryEvent(topic); got != want {
			t.Errorf("KnownBerryEvent(%q) = %t, want %t", topic, got, want)
		}
	}
	if !MatchesBerryEvent("issue.*", "issue.completed") || MatchesBerryEvent("issue.*", "goal.completed") ||
		!MatchesBerryEvent("goal.completed", "goal.completed") {
		t.Fatal("MatchesBerryEvent does not honour the wildcard")
	}
}

func TestParseDurationReadsTheISOSubset(t *testing.T) {
	cases := map[string]time.Duration{
		"PT30M": 30 * time.Minute, "PT4H": 4 * time.Hour, "P7D": 7 * 24 * time.Hour,
		"P2W": 14 * 24 * time.Hour, "P1DT2H3M4S": 26*time.Hour + 3*time.Minute + 4*time.Second,
	}
	for text, want := range cases {
		if got, ok := ParseDuration(text); !ok || got != want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", text, got, ok, want)
		}
	}
	for _, text := range []string{"", "P", "PT", "30m", "P1Y"} {
		if _, ok := ParseDuration(text); ok {
			t.Errorf("ParseDuration(%q) accepted", text)
		}
	}
}
