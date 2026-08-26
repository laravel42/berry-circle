package ir

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

// Codes for a reply that is not a plan at all, before any structural rule.
const (
	CodePlanJSONInvalid   = "PLAN_JSON_INVALID"
	CodePlanSchemaInvalid = "PLAN_SCHEMA_INVALID"
)

// ExtractJSON finds the one JSON object in a model reply. A model asked for
// JSON still wraps it in fences or prose now and then; the object is taken
// from the first "{" to its balancing "}", string literals and escapes
// respected, and everything around it is ignored. ok is false when no
// balanced object exists.
func ExtractJSON(reply string) ([]byte, bool) {
	text := strings.TrimSpace(reply)
	if fenced, ok := betweenFences(text); ok {
		text = fenced
	}
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return nil, false
	}
	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(text); index++ {
		char := text[index]
		switch {
		case inString:
			switch {
			case escaped:
				escaped = false
			case char == '\\':
				escaped = true
			case char == '"':
				inString = false
			}
		case char == '"':
			inString = true
		case char == '{':
			depth++
		case char == '}':
			depth--
			if depth == 0 {
				return []byte(text[start : index+1]), true
			}
		}
	}
	return nil, false
}

// betweenFences returns the body of the first ``` block when the reply is
// fenced.
func betweenFences(text string) (string, bool) {
	open := strings.Index(text, "```")
	if open < 0 {
		return "", false
	}
	rest := text[open+3:]
	if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
		// Drop the language tag on the opening fence line.
		if !strings.ContainsAny(rest[:newline], "{}") {
			rest = rest[newline+1:]
		}
	}
	closing := strings.Index(rest, "```")
	if closing < 0 {
		return strings.TrimSpace(rest), true
	}
	return strings.TrimSpace(rest[:closing]), true
}

// ParsePlanReply turns a planner reply into a plan and the findings that
// stop it: an unparsable reply, a shape the schema refuses, or a structural
// rule broken. A non-empty findings list with at least one error means the
// plan is invalid and the returned plan may be partial.
func ParsePlanReply(reply string) (Plan, []Finding) {
	raw, ok := extractAnswer(reply)
	if !ok {
		return Plan{}, []Finding{finding("", CodePlanJSONInvalid, "The reply does not contain a JSON object.")}
	}
	plan, err := Parse(raw)
	if err != nil {
		return Plan{}, []Finding{finding("", CodePlanSchemaInvalid, DescribeDecodeError(err))}
	}
	return plan, CheckStructure(plan)
}

// DescribeDecodeError keeps the decoder's field-level hint ("unknown field
// \"foo\"", "cannot unmarshal string into … of type int") and nothing else,
// so a finding names what to fix without echoing the reply.
func DescribeDecodeError(err error) string {
	var typeError *json.UnmarshalTypeError
	if errors.As(err, &typeError) {
		where := typeError.Field
		if where == "" {
			where = "the document"
		}
		return fmt.Sprintf("Field %s must be %s, not %s.", where, typeError.Type, typeError.Value)
	}
	var syntaxError *json.SyntaxError
	if errors.As(err, &syntaxError) {
		return fmt.Sprintf("The JSON is malformed at byte %d: %s.", syntaxError.Offset, syntaxError.Error())
	}
	message := err.Error()
	message = strings.TrimPrefix(message, "plan is not valid BerryPlan JSON: ")
	message = strings.TrimPrefix(message, "json: ")
	return strings.TrimSpace(message)
}

// decodeStrict decodes one JSON document refusing unknown fields and
// trailing data.
func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}

// Errors returns only the error-severity findings.
func Errors(findings []Finding) []Finding {
	var out []Finding
	for _, item := range findings {
		if item.Severity != automation.SeverityWarning {
			out = append(out, item)
		}
	}
	return out
}

// Warnings returns only the warning-severity findings.
func Warnings(findings []Finding) []Finding {
	var out []Finding
	for _, item := range findings {
		if item.Severity == automation.SeverityWarning {
			out = append(out, item)
		}
	}
	return out
}

// Codes lists the distinct codes of findings in first-seen order.
func Codes(findings []Finding) []string {
	seen := map[string]bool{}
	var codes []string
	for _, item := range findings {
		if seen[item.Code] {
			continue
		}
		seen[item.Code] = true
		codes = append(codes, item.Code)
	}
	if codes == nil {
		codes = []string{}
	}
	return codes
}

// stripSchemaEnvelope removes the JSON Schema keywords a small model echoes
// from the schema it was shown into the object it answers with ("title",
// "type": "object", "additionalProperties", "required", "properties"), and
// unwraps an answer the model nested under "properties" with nothing but
// keywords beside it. A key is only treated as a keyword when its value has
// the keyword's shape, so a payload field of the same name survives; the
// plan's own "$schema" is never touched. Anything that is not an object is
// returned unchanged for the strict decoder to report.
func stripSchemaEnvelope(raw []byte) []byte {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || len(object) == 0 {
		return raw
	}
	changed := false
	if nested, ok := object["properties"]; ok && onlySchemaKeywords(object) {
		var inner map[string]json.RawMessage
		if json.Unmarshal(nested, &inner) == nil && len(inner) > 0 {
			object = inner
			changed = true
		}
	}
	for key, value := range object {
		if isSchemaKeyword(key, value) {
			delete(object, key)
			changed = true
		}
	}
	if !changed {
		return raw
	}
	out, err := json.Marshal(object)
	if err != nil {
		return raw
	}
	return out
}

// onlySchemaKeywords reports whether every key of the object is a schema
// keyword, i.e. the object is a schema shell rather than an answer.
func onlySchemaKeywords(object map[string]json.RawMessage) bool {
	for key, value := range object {
		if key == "properties" {
			continue
		}
		if !isSchemaKeyword(key, value) {
			return false
		}
	}
	return true
}

func isSchemaKeyword(key string, value json.RawMessage) bool {
	switch key {
	case "title":
		var text string
		return json.Unmarshal(value, &text) == nil
	case "type":
		var text string
		return json.Unmarshal(value, &text) == nil && text == "object"
	case "additionalProperties":
		var flag bool
		return json.Unmarshal(value, &flag) == nil
	case "required":
		var names []string
		return json.Unmarshal(value, &names) == nil
	case "properties":
		var inner map[string]json.RawMessage
		return json.Unmarshal(value, &inner) == nil
	}
	return false
}

// extractAnswer is ExtractJSON followed by the schema-envelope strip: the
// reply parsers read models' answers through it so an echoed schema header
// never reaches the strict decoder.
func extractAnswer(reply string) ([]byte, bool) {
	raw, ok := ExtractJSON(reply)
	if !ok {
		return nil, false
	}
	return stripSchemaEnvelope(raw), true
}
