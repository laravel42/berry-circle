package automation

import (
	"encoding/json"
	"testing"
)

// sampleDefinition is a valid donation-style workflow: a Berry event starts
// it, a condition branches on the payload, an action posts, an approval gates
// a second action, and a create_issue step reads the trigger.
const sampleDefinition = `{
  "version": "1",
  "trigger": {"id": "on_done", "type": "berry_event", "event": "issue.completed",
              "config": {"filter": {"op": "exists", "left": {"ref": "trigger.issue"}}}},
  "entry": ["check"],
  "steps": [
    {"id": "check", "type": "condition",
     "expression": {"op": "greater_than", "left": {"ref": "trigger.amount"}, "right": 100},
     "trueSteps": ["notify"], "falseSteps": ["ticket"]},
    {"id": "notify", "type": "action", "provider": "slack", "operation": "post_message",
     "input": {"channel": "#donations", "text": "Thanks {{ trigger.donor.name }}"}},
    {"id": "gate", "type": "approval", "title": "Deploy?", "approver": {"type": "role", "role": "admin"},
     "dependsOn": ["notify"], "timeout": "P7D"},
    {"id": "deploy", "type": "action", "provider": "github", "operation": "create_deployment",
     "input": {"ref": {"ref": "steps.notify.output.ts"}}, "dependsOn": ["gate"]},
    {"id": "ticket", "type": "create_issue", "title": "Follow up {{ trigger.donor.name }}",
     "priority": "medium", "goalId": "{{ goal.id }}"},
    {"id": "pause", "type": "wait", "mode": "duration", "duration": "PT30M", "dependsOn": ["ticket"]}
  ]
}`

func parseSample(t *testing.T) Definition {
	t.Helper()
	definition, findings := ParseDefinition([]byte(sampleDefinition))
	if len(findings) > 0 {
		t.Fatalf("sample definition does not parse: %+v", findings)
	}
	return definition
}

// mutate re-encodes the sample through a generic map so a test can change one
// key without hand-writing the whole document.
func mutate(t *testing.T, edit func(document map[string]any)) Definition {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(sampleDefinition), &document); err != nil {
		t.Fatalf("decode sample: %v", err)
	}
	edit(document)
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode sample: %v", err)
	}
	definition, findings := ParseDefinition(encoded)
	if len(findings) > 0 {
		t.Fatalf("mutated definition does not parse: %+v", findings)
	}
	return definition
}

func steps(document map[string]any) []any {
	return document["steps"].([]any)
}

func step(document map[string]any, id string) map[string]any {
	for _, entry := range steps(document) {
		object := entry.(map[string]any)
		if object["id"] == id {
			return object
		}
	}
	return nil
}

func codes(findings []FieldError) []string {
	result := make([]string, 0, len(findings))
	for _, finding := range findings {
		result = append(result, finding.Code+"@"+finding.Path)
	}
	return result
}

func hasCode(findings []FieldError, code, path string) bool {
	for _, finding := range findings {
		if finding.Code == code && (path == "" || finding.Path == path) {
			return true
		}
	}
	return false
}

// fakeCatalog is a registry projection for tests.
type fakeCatalog struct {
	tools     map[string]ToolSpec
	connected map[string]bool
}

func (catalog fakeCatalog) Tool(provider, operation string, kind ToolKind) (ToolSpec, bool) {
	spec, ok := catalog.tools[provider+"."+operation]
	if !ok || spec.Kind != kind {
		return ToolSpec{}, false
	}
	return spec, true
}

func (catalog fakeCatalog) Connected(provider string) bool {
	return catalog.connected[provider]
}

func sampleCatalog() fakeCatalog {
	return fakeCatalog{
		tools: map[string]ToolSpec{
			"slack.post_message": {
				Provider: "slack", Operation: "post_message", Kind: ToolAction, ConnectionRequired: true,
				InputSchema: map[string]any{
					"required":             []any{"channel", "text"},
					"properties":           map[string]any{"channel": map[string]any{}, "text": map[string]any{}},
					"additionalProperties": false,
				},
			},
			"github.create_deployment": {
				Provider: "github", Operation: "create_deployment", Kind: ToolAction,
				ConnectionRequired: true, Destructive: true,
			},
			"stripe.payment_succeeded": {
				Provider: "stripe", Operation: "payment_succeeded", Kind: ToolTrigger, ConnectionRequired: true,
			},
		},
		connected: map[string]bool{"slack": true, "github": true},
	}
}
