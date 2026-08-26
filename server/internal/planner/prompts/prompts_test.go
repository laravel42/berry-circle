package prompts

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

// Every prompt renders its schema, fits the runtime's system prompt bound
// (20000 bytes; PatchAgent and the manifest refuse more), and carries a
// distinct version; the schema texts themselves are valid JSON.
func TestPromptsRenderWithinTheRuntimeBound(t *testing.T) {
	versions := map[string]bool{}
	for _, prompt := range All() {
		if prompt.Text == "" || prompt.Version == "" || prompt.Role == "" {
			t.Fatalf("prompt %+v is incomplete", prompt.Role)
		}
		if strings.Contains(prompt.Text, "<<") {
			t.Fatalf("%s still carries a placeholder", prompt.Role)
		}
		if len(prompt.Text) > 20000 {
			t.Fatalf("%s prompt is %d bytes, over the 20000 byte bound", prompt.Role, len(prompt.Text))
		}
		if versions[prompt.Version] {
			t.Fatalf("version %s reused", prompt.Version)
		}
		versions[prompt.Version] = true
		if _, ok := ForRole(prompt.Role); !ok {
			t.Fatalf("ForRole(%s) missing", prompt.Role)
		}
	}
	for name, schema := range map[string]string{"plan": ir.PlanSchemaJSON, "intent": ir.IntentSchemaJSON, "critic": ir.CriticSchemaJSON} {
		if !json.Valid([]byte(schema)) {
			t.Fatalf("%s schema is not valid JSON", name)
		}
	}
	if !strings.Contains(Planner().Text, `"title": "BerryPlan v1"`) || !strings.Contains(Repair().Text, `"title": "BerryPlan v1"`) {
		t.Fatal("planner and repair prompts must carry the plan schema")
	}
	if !strings.Contains(Classifier().Text, `"title": "IntentAnalysis"`) || !strings.Contains(Critic().Text, `"title": "CriticVerdict"`) {
		t.Fatal("classifier and critic prompts must carry their schemas")
	}
	// The examples in the planner prompt must themselves be valid plans.
	for _, line := range strings.Split(Planner().Text, "\n") {
		if !strings.HasPrefix(line, `{"$schema":"berry-plan/1"`) {
			continue
		}
		plan, findings := ir.ParsePlanReply(line)
		if !ir.Valid(findings) {
			t.Fatalf("example plan %q is invalid: %+v", plan.Goal.Title, findings)
		}
	}
}
