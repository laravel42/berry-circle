package ir

import (
	"strings"
	"testing"
)

const validPlan = `{
  "$schema": "berry-plan/1", "version": "1",
  "goal": {"tempId": "g_site", "title": "Launch the donation site"},
  "issues": [
    {"tempId": "i_design", "title": "Design the page", "type": "issue", "requiredCapabilities": ["design"]},
    {"tempId": "i_build", "title": "Build the page", "type": "issue", "dependsOn": ["i_design"]},
    {"tempId": "i_deploy", "title": "Deploy to production", "type": "issue", "dependsOn": ["i_build"], "requiresApproval": true}
  ],
  "workflows": [{
    "tempId": "w_thanks", "name": "Thank donors",
    "trigger": {"id": "on_done", "type": "berry_event", "event": "issue.completed"},
    "steps": [{"id": "notify", "type": "create_issue", "title": "Thank {{ trigger.issue.identifier }}"}],
    "entry": ["notify"]
  }],
  "approvals": [{"tempId": "p_deploy", "title": "Deploy?", "reason": "policy",
    "target": {"kind": "issue", "tempId": "i_deploy"}, "approver": {"type": "role", "role": "admin"}}],
  "dependencies": [{"from": "i_build", "to": "i_design", "kind": "blocks"}],
  "confidence": 0.8
}`

func TestParseAndCheckStructureAcceptTheGoldenPlan(t *testing.T) {
	plan, err := Parse([]byte(validPlan))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if findings := CheckStructure(plan); !Valid(findings) {
		t.Fatalf("findings = %+v", findings)
	}
	ordered, ok := TopologicalIssues(plan.Issues)
	if !ok || len(ordered) != 3 || ordered[0].TempID != "i_design" || ordered[2].TempID != "i_deploy" {
		t.Fatalf("TopologicalIssues() = %+v, %v", ordered, ok)
	}
	definition := plan.Workflows[0].Definition()
	if definition.Version != "1" || len(definition.Steps) != 1 || definition.Steps[0].CreateIssue == nil {
		t.Fatalf("Definition() = %+v", definition)
	}
}

func TestParseRefusesUnknownFieldsAndCheckStructureNamesEveryProblem(t *testing.T) {
	if _, err := Parse([]byte(`{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"x"},"sql":"DROP"}`)); err == nil {
		t.Fatal("unknown field accepted")
	}
	broken := strings.NewReplacer(
		`"dependsOn": ["i_design"]},`, `"dependsOn": ["i_deploy"]},`,
		`"tempId": "i_deploy", "title": "Deploy to production", "type": "issue", "dependsOn": ["i_build"]`,
		`"tempId": "i_deploy", "title": "Deploy to production", "type": "issue", "dependsOn": ["i_build", "i_missing"]`,
	).Replace(validPlan)
	plan, err := Parse([]byte(broken))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	codes := map[string]bool{}
	for _, item := range CheckStructure(plan) {
		codes[item.Code] = true
	}
	for _, want := range []string{"DEP_CYCLE", "DEP_UNKNOWN_REF"} {
		if !codes[want] {
			t.Errorf("missing finding %s in %v", want, codes)
		}
	}
	if _, ok := TopologicalIssues(plan.Issues); ok {
		t.Fatal("cycle ordered")
	}
}
