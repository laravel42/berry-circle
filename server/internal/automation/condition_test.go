package automation

import (
	"encoding/json"
	"testing"
)

func condition(t *testing.T, text string) Condition {
	t.Helper()
	var parsed Condition
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("decode condition: %v", err)
	}
	return parsed
}

// Operand rules are what keep the expression system typed: a comparison has
// two operands, exists has one reference, and/or take one to ten arguments,
// not exactly one.
func TestConditionOperandRules(t *testing.T) {
	t.Parallel()
	cases := map[string]struct {
		text     string
		wantCode bool
	}{
		"comparison with both operands":   {`{"op":"equals","left":{"ref":"trigger.a"},"right":1}`, false},
		"comparison missing right":        {`{"op":"gte","left":{"ref":"trigger.a"}}`, true},
		"exists with a reference":         {`{"op":"exists","left":{"ref":"trigger.a"}}`, false},
		"exists with a literal":           {`{"op":"exists","left":"x"}`, true},
		"and with two args":               {`{"op":"and","args":[{"op":"exists","left":{"ref":"trigger.a"}},{"op":"exists","left":{"ref":"trigger.b"}}]}`, false},
		"and with no args":                {`{"op":"and","args":[]}`, true},
		"not with two args":               {`{"op":"not","args":[{"op":"exists","left":{"ref":"trigger.a"}},{"op":"exists","left":{"ref":"trigger.b"}}]}`, true},
		"unknown operator":                {`{"op":"regex","left":"a","right":"b"}`, true},
		"invalid reference in an operand": {`{"op":"equals","left":{"ref":"env.X"},"right":1}`, true},
		"nested invalid argument":         {`{"op":"or","args":[{"op":"equals","left":1}]}`, true},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			findings := condition(t, testCase.text).Validate("/x")
			if (len(findings) > 0) != testCase.wantCode {
				t.Fatalf("findings = %v, want error %t", codes(findings), testCase.wantCode)
			}
		})
	}
}

// Comparisons between different kinds are errors, not false, so a misrouted
// field cannot silently take the false branch.
func TestEvaluateConditions(t *testing.T) {
	t.Parallel()
	scope := Scope{"trigger": map[string]any{
		"amount": float64(1500), "currency": "usd", "tags": []any{"vip", "new"}, "donor": map[string]any{"name": "Ada"},
	}}
	cases := map[string]struct {
		text    string
		want    bool
		wantErr bool
	}{
		"greater than":          {`{"op":"greater_than","left":{"ref":"trigger.amount"},"right":1000}`, true, false},
		"less than":             {`{"op":"less_than","left":{"ref":"trigger.amount"},"right":1000}`, false, false},
		"equals string":         {`{"op":"equals","left":{"ref":"trigger.currency"},"right":"usd"}`, true, false},
		"not equals":            {`{"op":"not_equals","left":{"ref":"trigger.currency"},"right":"eur"}`, true, false},
		"template equals":       {`{"op":"equals","left":"{{ trigger.donor.name }}!","right":"Ada!"}`, true, false},
		"contains array":        {`{"op":"contains","left":{"ref":"trigger.tags"},"right":"vip"}`, true, false},
		"contains string":       {`{"op":"contains","left":{"ref":"trigger.currency"},"right":"sd"}`, true, false},
		"exists":                {`{"op":"exists","left":{"ref":"trigger.donor.name"}}`, true, false},
		"exists missing":        {`{"op":"exists","left":{"ref":"trigger.donor.email"}}`, false, false},
		"and":                   {`{"op":"and","args":[{"op":"exists","left":{"ref":"trigger.amount"}},{"op":"gte","left":{"ref":"trigger.amount"},"right":1500}]}`, true, false},
		"or short-circuits":     {`{"op":"or","args":[{"op":"exists","left":{"ref":"trigger.nope"}},{"op":"lte","left":{"ref":"trigger.amount"},"right":1500}]}`, true, false},
		"not":                   {`{"op":"not","args":[{"op":"exists","left":{"ref":"trigger.nope"}}]}`, true, false},
		"number against string": {`{"op":"greater_than","left":{"ref":"trigger.amount"},"right":"1000"}`, false, true},
		"unresolved reference":  {`{"op":"equals","left":{"ref":"trigger.missing"},"right":1}`, false, true},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			got, err := Evaluate(condition(t, testCase.text), scope)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("Evaluate error = %v, want error %t", err, testCase.wantErr)
			}
			if got != testCase.want {
				t.Fatalf("Evaluate = %t, want %t", got, testCase.want)
			}
		})
	}
}
