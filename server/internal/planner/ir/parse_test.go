package ir

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// The model reply is JSON wrapped in whatever the model felt like: fences,
// prose, trailing remarks. Extraction takes the one balanced object and the
// strict decoder still refuses anything outside the schema.
func TestParsePlanReplyToleratesWrappingAndRefusesShape(t *testing.T) {
	cases := map[string]struct {
		reply     string
		wantCodes []string
		wantTitle string
	}{
		"bare":             {reply: validPlan, wantTitle: "Launch the donation site"},
		"fenced json":      {reply: "Here is the plan:\n```json\n" + validPlan + "\n```\nLet me know.", wantTitle: "Launch the donation site"},
		"fenced no tag":    {reply: "```\n" + validPlan + "\n```", wantTitle: "Launch the donation site"},
		"prose around":     {reply: "Sure! " + validPlan + " Hope this helps {not json}", wantTitle: "Launch the donation site"},
		"braces in text":   {reply: strings.Replace(validPlan, `"title": "Launch the donation site"`, `"title": "Launch {the} \"donation\" site"`, 1), wantTitle: `Launch {the} "donation" site`},
		"no object":        {reply: "I cannot help with that.", wantCodes: []string{CodePlanJSONInvalid}},
		"unbalanced":       {reply: `{"$schema": "berry-plan/1", "version": "1", "goal": {"tempId": "g_x"`, wantCodes: []string{CodePlanJSONInvalid}},
		"unknown field":    {reply: `{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"x"},"sql":"DROP"}`, wantCodes: []string{CodePlanSchemaInvalid}},
		"wrong type":       {reply: `{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"x"},"confidence":"high"}`, wantCodes: []string{CodePlanSchemaInvalid}},
		"unknown step":     {reply: `{"$schema":"berry-plan/1","version":"1","goal":{"tempId":"g_1","title":"x"},"workflows":[{"tempId":"w_1","name":"n","trigger":{"id":"t","type":"manual"},"steps":[{"id":"s","type":"shell","command":"rm -rf"}],"entry":["s"]}]}`, wantCodes: []string{CodePlanSchemaInvalid}},
		"structural":       {reply: `{"$schema":"berry-plan/2","version":"1","goal":{"tempId":"goal","title":""}}`, wantCodes: []string{"PLAN_VERSION_UNSUPPORTED", "TEMP_ID_INVALID", "GOAL_REQUIRED", "PLAN_EMPTY"}},
		"empty reply":      {reply: "   ", wantCodes: []string{CodePlanJSONInvalid}},
		"array not object": {reply: `[{"$schema":"berry-plan/1"}]`, wantCodes: []string{"PLAN_VERSION_UNSUPPORTED", "GOAL_REQUIRED"}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			plan, findings := ParsePlanReply(tc.reply)
			if tc.wantCodes == nil {
				if !Valid(findings) || plan.Goal.Title != tc.wantTitle {
					t.Fatalf("plan = %q findings = %+v", plan.Goal.Title, findings)
				}
				return
			}
			codes := Codes(findings)
			for _, want := range tc.wantCodes {
				if !contains(codes, want) {
					t.Fatalf("codes = %v, want %s", codes, want)
				}
			}
			if Valid(findings) && !onlyWarnings(findings) {
				t.Fatalf("findings %v reported valid", findings)
			}
		})
	}
}

func TestErrorsWarningsAndCodesSplitFindings(t *testing.T) {
	findings := []Finding{
		finding("/a", "X", "x"),
		{Path: "/b", Code: "Y", Severity: "warning"},
		finding("/c", "X", "x"),
	}
	if len(Errors(findings)) != 2 || len(Warnings(findings)) != 1 {
		t.Fatalf("Errors/Warnings = %d/%d", len(Errors(findings)), len(Warnings(findings)))
	}
	if codes := Codes(findings); len(codes) != 2 || codes[0] != "X" || codes[1] != "Y" {
		t.Fatalf("Codes() = %v", codes)
	}
	if codes := Codes(nil); codes == nil || len(codes) != 0 {
		t.Fatalf("Codes(nil) = %#v, want empty non-nil", codes)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func onlyWarnings(findings []Finding) bool {
	return len(Errors(findings)) == 0 && len(findings) > 0
}

// Small models echo the schema's keywords into their answer, or nest the
// answer under "properties"; both must parse, while a payload key that
// happens to share a keyword's name, and the plan's own $schema, survive.
func TestStripSchemaEnvelope(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"keywords beside the answer", `{"title":"IntentAnalysis","type":"object","additionalProperties":false,"required":["goal"],"goal":"Fix it","requirements":[]}`, `{"goal":"Fix it","requirements":[]}`},
		{"answer nested under properties", `{"title":"CriticVerdict","type":"object","properties":{"verdict":"accept","problems":[]}}`, `{"problems":[],"verdict":"accept"}`},
		{"payload keys of the same name survive", `{"type":"bug","title":"x","required":"yes","goal":"g"}`, `{"goal":"g","required":"yes","type":"bug"}`},
		{"$schema and nested titles untouched", `{"$schema":"berry-plan/v1","goal":{"tempId":"g1","title":"T"}}`, `{"$schema":"berry-plan/v1","goal":{"tempId":"g1","title":"T"}}`},
		{"not an object", `[1,2]`, `[1,2]`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(stripSchemaEnvelope([]byte(tc.in)))
			var a, b any
			if json.Unmarshal([]byte(got), &a) != nil || json.Unmarshal([]byte(tc.want), &b) != nil || !reflect.DeepEqual(a, b) {
				t.Fatalf("stripSchemaEnvelope(%s) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
	analysis, findings := ParseIntentReply(`{"title":"IntentAnalysis","type":"object","additionalProperties":false,"goal":"Fix login","requirements":[{"id":"r1","description":"fix","nature":"finite_work","entities":[],"explicitConstraints":[]}],"ambiguities":[]}`)
	if len(Errors(findings)) != 0 || analysis.Goal != "Fix login" {
		t.Fatalf("ParseIntentReply with an echoed envelope = %+v, %v", analysis, findings)
	}
}
