package automation

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

// loopDefinition is a valid P4.5 workflow: a manual trigger, a transform, a
// switch, a foreach whose body reads the item, and a subworkflow call.
const loopDefinition = `{
  "version": "1",
  "trigger": {"id": "start", "type": "manual"},
  "entry": ["shape"],
  "steps": [
    {"id": "shape", "type": "transform", "output": {"rows": {"ref": "trigger.input.rows"}, "label": "Batch {{ trigger.input.name }}"}},
    {"id": "route", "type": "switch", "value": {"ref": "trigger.input.kind"}, "dependsOn": ["shape"],
     "cases": [{"equals": "bulk", "steps": ["each"]}, {"equals": "single", "steps": ["one"]}], "defaultSteps": ["one"]},
    {"id": "each", "type": "foreach", "items": {"ref": "steps.shape.output.rows"}, "steps": ["note"], "maxItems": 3},
    {"id": "note", "type": "create_issue", "title": "Row {{ item.name }}"},
    {"id": "one", "type": "create_issue", "title": "Single {{ steps.shape.output.label }}"},
    {"id": "child", "type": "subworkflow", "workflowId": "6f1d2c3b-4a5e-4f60-8a71-9b8c7d6e5f40", "input": {"rows": {"ref": "steps.each.output.results"}}, "dependsOn": ["each"]}
  ]
}`

func parseLoop(t *testing.T) Definition {
	t.Helper()
	definition, findings := ParseDefinition([]byte(loopDefinition))
	if len(findings) > 0 {
		t.Fatalf("loop definition does not parse: %+v", findings)
	}
	return definition
}

func mutateLoop(t *testing.T, edit func(document map[string]any)) Definition {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(loopDefinition), &document); err != nil {
		t.Fatal(err)
	}
	edit(document)
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	definition, findings := ParseDefinition(encoded)
	if len(findings) > 0 {
		t.Fatalf("mutated definition does not parse: %+v", findings)
	}
	return definition
}

func loopStep(document map[string]any, id string) map[string]any {
	for _, raw := range document["steps"].([]any) {
		step := raw.(map[string]any)
		if step["id"] == id {
			return step
		}
	}
	return nil
}

func TestExtendedNodesValidateAndAreSupported(t *testing.T) {
	t.Parallel()
	report := ValidateDefinition(parseLoop(t), ValidateOptions{})
	if !report.Valid() {
		t.Fatalf("loop definition refused: %v", codes(report.Errors))
	}
	for _, kind := range []StepType{StepSwitch, StepForeach, StepTransform, StepSubworkflow} {
		if !SupportedStepTypes[kind] {
			t.Errorf("%s is not supported", kind)
		}
	}
	// A deployment that narrows the supported set still reports the code.
	narrowed := ValidateDefinition(parseLoop(t), ValidateOptions{Supported: map[StepType]bool{StepCreateIssue: true, StepTransform: true, StepSwitch: true, StepSubworkflow: true}})
	if !hasCode(narrowed.Errors, "NODE_TYPE_UNSUPPORTED", "/steps/2/type") {
		t.Fatalf("narrowed = %v", codes(narrowed.Errors))
	}
}

func TestExtendedNodeRules(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		edit func(document map[string]any)
		code string
		path string
	}{
		"switch without cases": {
			func(d map[string]any) { loopStep(d, "route")["cases"] = []any{}; delete(d, "x") }, "SWITCH_CASES_EMPTY", "/steps/1/cases"},
		"switch case without equals": {
			func(d map[string]any) {
				loopStep(d, "route")["cases"] = []any{map[string]any{"steps": []any{"each"}}, map[string]any{"equals": "single", "steps": []any{"one"}}}
			}, "STEP_FIELD_REQUIRED", "/steps/1/cases/0/equals"},
		"switch without a value": {
			func(d map[string]any) { delete(loopStep(d, "route"), "value") }, "STEP_FIELD_REQUIRED", "/steps/1/value"},
		"switch value reading a later step": {
			func(d map[string]any) { loopStep(d, "route")["value"] = map[string]any{"ref": "steps.one.output.id"} }, "OUTPUT_REF_INVALID", "/steps/1/value"},
		"foreach items not a reference": {
			func(d map[string]any) { loopStep(d, "each")["items"] = []any{1, 2, 3} }, "FOREACH_NOT_ITERABLE", "/steps/2/items"},
		"foreach over the limit": {
			func(d map[string]any) { loopStep(d, "each")["maxItems"] = MaxForeachItems + 1 }, "FOREACH_LIMIT_INVALID", "/steps/2/maxItems"},
		"foreach without a body": {
			func(d map[string]any) { loopStep(d, "each")["steps"] = []any{} }, "FOREACH_BODY_EMPTY", "/steps/2/steps"},
		"foreach body containing a switch": {
			func(d map[string]any) {
				loopStep(d, "each")["steps"] = []any{"inner"}
				d["steps"] = append(d["steps"].([]any), map[string]any{"id": "inner", "type": "switch", "value": map[string]any{"ref": "item.kind"},
					"cases": []any{map[string]any{"equals": "a", "steps": []any{"note"}}}})
			}, "FOREACH_BODY_TYPE", "/steps/2/steps/0"},
		"foreach body used as an entry step": {
			func(d map[string]any) { d["entry"] = []any{"shape", "note"} }, "FOREACH_BODY_ENTRY", "/steps/2/steps/0"},
		"foreach body shared by two loops": {
			func(d map[string]any) {
				d["steps"] = append(d["steps"].([]any), map[string]any{"id": "again", "type": "foreach", "items": map[string]any{"ref": "steps.shape.output.rows"}, "steps": []any{"note"}, "dependsOn": []any{"shape"}})
			}, "FOREACH_BODY_SHARED", "/steps/6/steps/0"},
		"switch branching into a loop body": {
			func(d map[string]any) {
				loopStep(d, "route")["cases"] = []any{map[string]any{"equals": "bulk", "steps": []any{"note"}}}
			}, "FOREACH_BODY_ESCAPE", "/steps/1/cases/0/steps/0"},
		"item read outside a loop": {
			func(d map[string]any) { loopStep(d, "one")["title"] = "Row {{ item.name }}" }, "ITEM_REF_OUTSIDE_FOREACH", "/steps/4/title"},
		"transform without output": {
			func(d map[string]any) { loopStep(d, "shape")["output"] = map[string]any{} }, "TRANSFORM_OUTPUT_EMPTY", "/steps/0/output"},
		"transform reading a later step": {
			func(d map[string]any) {
				loopStep(d, "shape")["output"] = map[string]any{"x": map[string]any{"ref": "steps.one.output.id"}}
			}, "OUTPUT_REF_INVALID", "/steps/0/output/x"},
		"subworkflow without a uuid": {
			func(d map[string]any) { loopStep(d, "child")["workflowId"] = "not-a-uuid" }, "STEP_FIELD_INVALID", "/steps/5/workflowId"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			report := ValidateDefinition(mutateLoop(t, testCase.edit), ValidateOptions{})
			if !hasCode(report.Errors, testCase.code, testCase.path) {
				t.Fatalf("errors = %v, want %s@%s", codes(report.Errors), testCase.code, testCase.path)
			}
		})
	}
}

// An event wait's filter still reads the incoming event as item outside a
// loop: that reference predates loops and stays valid.
func TestEventWaitFilterMayReadItemOutsideALoop(t *testing.T) {
	t.Parallel()
	definition := mutate(t, func(d map[string]any) {
		d["steps"] = append(d["steps"].([]any), map[string]any{"id": "hold", "type": "wait", "mode": "event", "dependsOn": []any{"ticket"},
			"event": map[string]any{"provider": "berry", "event": "issue.completed", "filter": map[string]any{"op": "exists", "left": map[string]any{"ref": "item.issue"}}}})
	})
	if report := ValidateDefinition(definition, ValidateOptions{}); !report.Valid() {
		t.Fatalf("event filter refused: %v", codes(report.Errors))
	}
}

type fakeSubworkflows map[uuid.UUID]SubworkflowRef

func (catalog fakeSubworkflows) Subworkflow(id uuid.UUID) (SubworkflowRef, bool) {
	ref, ok := catalog[id]
	return ref, ok
}

func subworkflowDefinition(t *testing.T, target uuid.UUID) Definition {
	t.Helper()
	text := `{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["call"],
	  "steps":[{"id":"call","type":"subworkflow","workflowId":"` + target.String() + `"}]}`
	definition, findings := ParseDefinition([]byte(text))
	if len(findings) > 0 {
		t.Fatalf("definition: %+v", findings)
	}
	return definition
}

func leafDefinition(t *testing.T) Definition {
	t.Helper()
	definition, findings := ParseDefinition([]byte(`{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["one"],
	  "steps":[{"id":"one","type":"create_issue","title":"Leaf"}]}`))
	if len(findings) > 0 {
		t.Fatalf("definition: %+v", findings)
	}
	return definition
}

// Through the catalog the validator refuses a chain that returns to the
// workflow being validated, one that nests past the depth bound, and one
// that names a workflow that does not exist; an inactive child warns on a
// draft and blocks activation.
func TestSubworkflowCatalogRules(t *testing.T) {
	t.Parallel()
	self, a, b, c, leaf := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	catalog := fakeSubworkflows{
		a:    {Definition: subworkflowDefinition(t, b), Active: true},
		b:    {Definition: subworkflowDefinition(t, c), Active: true},
		c:    {Definition: subworkflowDefinition(t, leaf), Active: true},
		leaf: {Definition: leafDefinition(t), Active: true},
	}
	// self → a → b → c → leaf is four levels below self: too deep.
	report := ValidateDefinition(subworkflowDefinition(t, a), ValidateOptions{Subworkflows: catalog, AutomationID: &self})
	if !hasCode(report.Errors, "SUBWORKFLOW_DEPTH", "/steps/0/workflowId") {
		t.Fatalf("depth = %v", codes(report.Errors))
	}
	// self → c → leaf is fine.
	if report := ValidateDefinition(subworkflowDefinition(t, c), ValidateOptions{Subworkflows: catalog, AutomationID: &self}); !report.Valid() {
		t.Fatalf("two levels refused: %v", codes(report.Errors))
	}
	// A cycle back to self through a.
	cyclic := fakeSubworkflows{a: {Definition: subworkflowDefinition(t, self), Active: true}}
	report = ValidateDefinition(subworkflowDefinition(t, a), ValidateOptions{Subworkflows: cyclic, AutomationID: &self})
	if !hasCode(report.Errors, "SUBWORKFLOW_CYCLE", "/steps/0/workflowId") {
		t.Fatalf("cycle = %v", codes(report.Errors))
	}
	report = ValidateDefinition(subworkflowDefinition(t, self), ValidateOptions{AutomationID: &self})
	if !hasCode(report.Errors, "SUBWORKFLOW_CYCLE", "/steps/0/workflowId") {
		t.Fatalf("self call = %v", codes(report.Errors))
	}
	report = ValidateDefinition(subworkflowDefinition(t, uuid.New()), ValidateOptions{Subworkflows: catalog})
	if !hasCode(report.Errors, "SUBWORKFLOW_UNKNOWN", "/steps/0/workflowId") {
		t.Fatalf("unknown = %v", codes(report.Errors))
	}
	paused := fakeSubworkflows{leaf: {Definition: leafDefinition(t), Active: false}}
	draft := ValidateDefinition(subworkflowDefinition(t, leaf), ValidateOptions{Subworkflows: paused})
	if !draft.Valid() || !hasCode(draft.Warnings, "SUBWORKFLOW_NOT_ACTIVE", "/steps/0/workflowId") {
		t.Fatalf("inactive child on a draft = errors %v warnings %v", codes(draft.Errors), codes(draft.Warnings))
	}
	activation := ValidateDefinition(subworkflowDefinition(t, leaf), ValidateOptions{Subworkflows: paused, RequireConnections: true})
	if !hasCode(activation.Errors, "SUBWORKFLOW_NOT_ACTIVE", "/steps/0/workflowId") {
		t.Fatalf("inactive child on activation = %v", codes(activation.Errors))
	}
}

func TestStepRunIDsCarryTheForeachIndex(t *testing.T) {
	t.Parallel()
	if got := IndexedStepID("note", 2); got != "note[2]" {
		t.Fatalf("IndexedStepID = %s", got)
	}
	for id, want := range map[string]struct {
		base    string
		index   int
		indexed bool
		valid   bool
	}{
		"note":      {"note", -1, false, true},
		"note[0]":   {"note", 0, true, true},
		"note[99]":  {"note", 99, true, true},
		"note[999]": {"note", 999, true, true},
		"note[]":    {"note[]", -1, false, false},
		"note[a]":   {"note[a]", -1, false, false},
		"Note[1]":   {"Note[1]", -1, false, false},
	} {
		base, index, indexed := SplitStepRunID(id)
		if base != want.base || index != want.index || indexed != want.indexed || ValidStepRunID(id) != want.valid {
			t.Errorf("SplitStepRunID(%q) = %q, %d, %v (valid %v); want %+v", id, base, index, indexed, ValidStepRunID(id), want)
		}
	}
	if ValidStepID("note[0]") {
		t.Fatal("a definition step id accepted an index")
	}
}

func TestDispatchTopicsIncludeRunOutcomesWithoutMakingThemSubscribable(t *testing.T) {
	t.Parallel()
	seen := map[string]bool{}
	for _, topic := range DispatchTopics {
		seen[topic] = true
	}
	for _, topic := range []string{"workflow.run.succeeded", "workflow.run.failed", "workflow.run.cancelled", "issue.completed", "integration.webhook.received"} {
		if !seen[topic] {
			t.Errorf("DispatchTopics misses %s", topic)
		}
	}
	if KnownBerryEvent("workflow.run.succeeded") || KnownBerryEvent("workflow.*") {
		t.Fatal("workflow run outcomes must not be subscribable")
	}
}

func TestCronExpressionsAreParsedNotJustShaped(t *testing.T) {
	t.Parallel()
	if ValidCronExpression("60 * * * *") || ValidCronExpression("0 25 * * *") || ValidCronExpression("* * * * 8") {
		t.Fatal("an out-of-range field was accepted")
	}
	if !ValidCronExpression("0 9 * * 1") || !ValidCronExpression("*/15 * * * *") || !ValidCronExpression("@weekly") {
		t.Fatal("a valid expression was refused")
	}
}
