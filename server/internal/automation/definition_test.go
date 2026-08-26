package automation

import (
	"encoding/json"
	"testing"
)

// The definition is what a person or the planner stores; a key the vocabulary
// does not know is a mistake to point at, never something to drop silently.
func TestParseDefinitionIsStrictAndPointsAtTheField(t *testing.T) {
	t.Parallel()
	definition := parseSample(t)
	if len(definition.Steps) != 6 || definition.Steps[0].Condition == nil || definition.Steps[1].Action == nil ||
		definition.Steps[2].Approval == nil || definition.Steps[4].CreateIssue == nil || definition.Steps[5].Wait == nil {
		t.Fatalf("typed steps were not populated: %+v", definition.Steps)
	}
	if definition.Steps[2].DependsOn[0] != "notify" || definition.Steps[2].Approval.Timeout != "P7D" {
		t.Fatalf("header and body fields = %+v", definition.Steps[2])
	}

	_, findings := ParseDefinition([]byte(`{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["a"],
	  "steps":[{"id":"a","type":"wait","mode":"duration","duration":"PT1M","colour":"red"}]}`))
	if !hasCode(findings, "STEP_FIELD_INVALID", "/steps/0") {
		t.Fatalf("unknown step field was not reported at its step: %v", codes(findings))
	}
	_, findings = ParseDefinition([]byte(`{"version":"1","trigger":{"id":"t","type":"manual"},"entry":["a"],
	  "steps":[{"id":"a","type":"teleport"}]}`))
	if !hasCode(findings, "STEP_TYPE_INVALID", "/steps/0/type") {
		t.Fatalf("unknown step type was not reported: %v", codes(findings))
	}
	_, findings = ParseDefinition([]byte(`{"version":"2","trigger":{"id":"t","type":"manual"},"steps":[],"entry":[],"extra":1}`))
	if !hasCode(findings, "DEFINITION_INVALID_JSON", "") {
		t.Fatalf("unknown top-level field was not reported: %v", codes(findings))
	}
	_, findings = ParseDefinition([]byte(`{"version":"1","steps":[],"entry":[]}`))
	if !hasCode(findings, "WORKFLOW_TRIGGER_REQUIRED", "/trigger") {
		t.Fatalf("missing trigger was not reported: %v", codes(findings))
	}
	_, findings = ParseDefinition([]byte(`not json`))
	if !hasCode(findings, "DEFINITION_INVALID_JSON", "") {
		t.Fatalf("malformed JSON was not reported: %v", codes(findings))
	}
}

// A stored definition must come back byte-for-byte equivalent after a decode
// and encode, or the canvas would show a different workflow than the one
// that runs.
func TestDefinitionRoundTripsThroughJSON(t *testing.T) {
	t.Parallel()
	definition := parseSample(t)
	encoded, err := json.Marshal(definition)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded Definition
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	again, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("encode again: %v", err)
	}
	if string(encoded) != string(again) {
		t.Fatalf("round trip drifted:\n%s\n%s", encoded, again)
	}
	var original, roundTripped any
	if err := json.Unmarshal([]byte(sampleDefinition), &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &roundTripped); err != nil {
		t.Fatal(err)
	}
	if string(mustJSON(t, original)) != string(mustJSON(t, roundTripped)) {
		t.Fatalf("encoded definition differs from the source:\n%s\n%s", mustJSON(t, original), mustJSON(t, roundTripped))
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
