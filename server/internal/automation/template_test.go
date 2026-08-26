package automation

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestReferenceGrammarAdmitsOnlyTheFiveRoots(t *testing.T) {
	t.Parallel()
	for ref, want := range map[string]bool{
		"trigger":                     true,
		"trigger.customer.email":      true,
		"steps.notify.output.ts":      true,
		"steps.notify":                false,
		"steps.Notify.output":         false,
		"connections.google_sheets.x": true,
		"goal.id":                     true,
		"item.name":                   true,
		"env.SECRET":                  false,
		"trigger.":                    false,
		"":                            false,
	} {
		if got := ValidReference(ref); got != want {
			t.Errorf("ValidReference(%q) = %t, want %t", ref, got, want)
		}
	}
	if id, ok := ReferencedStep("steps.notify.output.ts"); !ok || id != "notify" {
		t.Fatalf("ReferencedStep = %q %t", id, ok)
	}
	if _, ok := ReferencedStep("trigger.x"); ok {
		t.Fatal("ReferencedStep claimed the trigger is a step")
	}
}

// A placeholder that never closes or names an invalid path must fail at
// validation, not render the braces into a provider call.
func TestTemplatesRenderAndRefuseBrokenPlaceholders(t *testing.T) {
	t.Parallel()
	scope := Scope{
		"trigger": map[string]any{"donor": map[string]any{"name": "Ada"}, "amount": float64(250)},
		"steps":   map[string]any{"notify": map[string]any{"output": map[string]any{"ts": "123"}}},
	}
	rendered, err := Render("Thanks {{ trigger.donor.name }} for {{trigger.amount}} ({{ steps.notify.output.ts }})", scope)
	if err != nil || rendered != "Thanks Ada for 250 (123)" {
		t.Fatalf("Render = %q, %v", rendered, err)
	}
	if _, err := Render("Hello {{ trigger.name", scope); err == nil {
		t.Fatal("unclosed placeholder rendered")
	}
	if _, err := Render("Hello {{ env.TOKEN }}", scope); err == nil {
		t.Fatal("invalid reference rendered")
	}
	if _, err := Render("Hello {{ trigger.missing }}", scope); err == nil {
		t.Fatal("unresolved reference rendered as empty")
	}
	refs, err := TemplateReferences("{{ trigger.a }} and {{ steps.x.output.b }}")
	if err != nil || !reflect.DeepEqual(refs, []string{"trigger.a", "steps.x.output.b"}) {
		t.Fatalf("TemplateReferences = %v, %v", refs, err)
	}
}

// Inputs may nest objects and arrays; every reference inside them is found
// and resolved, and a lone {"ref": …} object is a reference, not an object.
func TestValuesResolveReferencesAtAnyDepth(t *testing.T) {
	t.Parallel()
	scope := Scope{"trigger": map[string]any{"rows": []any{"a", "b"}, "n": float64(2)}}
	raw := json.RawMessage(`{"values": [{"ref": "trigger.rows"}, "n={{ trigger.n }}"], "flag": true, "nested": {"count": {"ref": "trigger.n"}}}`)
	refs, err := ValueReferences(raw)
	if err != nil || len(refs) != 3 {
		t.Fatalf("ValueReferences = %v, %v", refs, err)
	}
	resolved, err := ResolveValue(raw, scope)
	if err != nil {
		t.Fatalf("ResolveValue: %v", err)
	}
	want := map[string]any{
		"values": []any{[]any{"a", "b"}, "n=2"},
		"flag":   true,
		"nested": map[string]any{"count": float64(2)},
	}
	if !reflect.DeepEqual(resolved, want) {
		t.Fatalf("ResolveValue = %#v, want %#v", resolved, want)
	}
	if _, err := ValueReferences(json.RawMessage(`{"ref": "env.X"}`)); err == nil {
		t.Fatal("invalid reference object accepted")
	}
	if _, err := ResolveValue(json.RawMessage(`{"ref": "trigger.nope"}`), scope); err == nil {
		t.Fatal("unresolved reference object accepted")
	}
	if ref, ok := ParseReference(json.RawMessage(`{"ref": "trigger.a", "extra": 1}`)); ok {
		t.Fatalf("object with an extra key parsed as reference %+v", ref)
	}
}
