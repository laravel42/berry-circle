package jsonschema

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func decode(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	return value
}

func schema(t *testing.T, text string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("decode schema %s: %v", text, err)
	}
	return value
}

func TestCheckAppliesTheSupportedKeywords(t *testing.T) {
	t.Parallel()
	answer := schema(t, `{
	  "type": "object", "additionalProperties": false,
	  "required": ["summary", "score", "tags"],
	  "properties": {
	    "summary": {"type": "string", "minLength": 1, "maxLength": 20},
	    "score": {"type": "integer", "minimum": 0, "maximum": 10},
	    "tags": {"type": "array", "maxItems": 3, "items": {"type": "string", "pattern": "^[a-z]+$"}},
	    "kind": {"enum": ["issue", "workflow"]},
	    "owner": {"$ref": "#/$defs/Owner"},
	    "extra": {"type": ["string", "null"]}
	  },
	  "$defs": {"Owner": {"oneOf": [
	    {"type": "object", "required": ["userId"], "properties": {"userId": {"type": "string", "format": "uuid"}}, "additionalProperties": false},
	    {"type": "object", "required": ["role"], "properties": {"role": {"const": "admin"}}, "additionalProperties": false}
	  ]}}
	}`)
	if err := Check(decode(t, `{"summary":"ok","score":7,"tags":["a","b"],"kind":"issue","owner":{"role":"admin"},"extra":null}`), answer); err != nil {
		t.Fatalf("valid answer refused: %v", err)
	}
	cases := map[string]string{
		`{"summary":"ok","score":7}`:                                     "$ is missing the required property \"tags\"",
		`{"summary":"","score":7,"tags":[]}`:                             "$.summary is shorter than 1",
		`{"summary":"ok","score":7.5,"tags":[]}`:                         "$.score is not a integer",
		`{"summary":"ok","score":11,"tags":[]}`:                          "$.score is above the maximum 10",
		`{"summary":"ok","score":1,"tags":["a","b","c","d"]}`:            "$.tags has more than 3 items",
		`{"summary":"ok","score":1,"tags":["A"]}`:                        "$.tags[0] does not match the pattern",
		`{"summary":"ok","score":1,"tags":[],"kind":"goal"}`:             "$.kind is not one of the allowed values",
		`{"summary":"ok","score":1,"tags":[],"owner":{"userId":"nope"}}`: "$.owner does not satisfy oneOf",
		`{"summary":"ok","score":1,"tags":[],"owner":{"role":"member"}}`: "$.owner does not satisfy oneOf",
		`{"summary":"ok","score":1,"tags":[],"unknown":1}`:               "$ has the unexpected property \"unknown\"",
		`{"summary":"ok","score":1,"tags":[],"extra":3}`:                 "$.extra is not a string or null",
		`["not","an","object"]`:                                          "$ is not a object",
	}
	for text, expected := range cases {
		err := Check(decode(t, text), answer)
		if err == nil || !strings.Contains(err.Error(), expected) {
			t.Errorf("Check(%s) = %v, want %q", text, err, expected)
		}
		var typed *Error
		if err != nil && !errors.As(err, &typed) {
			t.Errorf("Check(%s) returned %T, want *Error", text, err)
		}
	}
	if err := Check(decode(t, `"anything"`), nil); err != nil {
		t.Fatalf("nil schema refused: %v", err)
	}
}

func TestCheckStopsOnBrokenReferencesAndDepth(t *testing.T) {
	t.Parallel()
	if err := Check(decode(t, `1`), schema(t, `{"$ref": "#/$defs/Missing"}`)); err == nil || !strings.Contains(err.Error(), "does not resolve") {
		t.Fatalf("missing ref = %v", err)
	}
	if err := Check(decode(t, `1`), schema(t, `{"$ref": "https://example.com/x"}`)); err == nil || !strings.Contains(err.Error(), "local") {
		t.Fatalf("remote ref = %v", err)
	}
	loop := schema(t, `{"$ref": "#/$defs/Loop", "$defs": {"Loop": {"$ref": "#/$defs/Loop"}}}`)
	if err := Check(decode(t, `1`), loop); err == nil || !strings.Contains(err.Error(), "deeper") {
		t.Fatalf("self reference = %v", err)
	}
}

func TestValidateRefusesMalformedSchemas(t *testing.T) {
	t.Parallel()
	for text, expected := range map[string]string{
		`{"type": "thing"}`:               "unknown",
		`{"type": 3}`:                     "type is a string",
		`{"properties": {"a": "string"}}`: "not a schema object",
		`{"items": true}`:                 "items is a schema object",
		`{"anyOf": []}`:                   "non-empty",
		`{"pattern": "("}`:                "pattern does not compile",
		`{"properties": {"a": {"type": ["string", 1]}}}`: "unknown type",
	} {
		err := Validate(schema(t, text))
		if err == nil || !strings.Contains(err.Error(), expected) {
			t.Errorf("Validate(%s) = %v, want %q", text, err, expected)
		}
	}
	if err := Validate(schema(t, `{"type": "object", "properties": {"a": {"type": "string"}}, "items": {"type": "number"}, "anyOf": [{"type": "null"}], "$defs": {"x": {"type": "boolean"}}}`)); err != nil {
		t.Fatalf("valid schema refused: %v", err)
	}
}
