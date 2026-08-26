// Package jsonschema checks a decoded JSON value against the subset of JSON
// Schema Berry uses for model answers: the planner IR schema, an agent
// step's outputSchema and the schema an ask names. It is a validator for
// shapes Berry authors, not a general implementation: draft keywords it
// does not know are ignored rather than refused, and $ref only resolves
// inside the same document.
package jsonschema

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// MaxDepth bounds nesting so a self-referential schema cannot recurse
// forever.
const MaxDepth = 64

// Error is one finding with the JSON path it applies to.
type Error struct {
	Path    string
	Message string
}

func (err *Error) Error() string {
	return err.Path + " " + err.Message
}

func fail(path, format string, arguments ...any) error {
	return &Error{Path: path, Message: fmt.Sprintf(format, arguments...)}
}

// Check reports the first place value does not satisfy schema. A nil or
// empty schema accepts everything.
func Check(value any, schema map[string]any) error {
	if len(schema) == 0 {
		return nil
	}
	return check(value, schema, schema, "$", 0)
}

func check(value any, schema, root map[string]any, path string, depth int) error {
	if depth > MaxDepth {
		return fail(path, "schema nests deeper than %d levels", MaxDepth)
	}
	if ref, ok := schema["$ref"].(string); ok {
		target, err := resolve(ref, root)
		if err != nil {
			return fail(path, "%s", err.Error())
		}
		return check(value, target, root, path, depth+1)
	}
	if typed, ok := schema["type"]; ok {
		if err := checkType(value, typed, path); err != nil {
			return err
		}
	}
	if expected, ok := schema["const"]; ok && !equal(value, expected) {
		return fail(path, "must equal the constant %v", expected)
	}
	if options, ok := schema["enum"].([]any); ok {
		matched := false
		for _, option := range options {
			if equal(value, option) {
				matched = true
				break
			}
		}
		if !matched {
			return fail(path, "is not one of the allowed values")
		}
	}
	if combinations, ok := schema["allOf"].([]any); ok {
		for index, raw := range combinations {
			nested, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if err := check(value, nested, root, path, depth+1); err != nil {
				return fail(path, "does not satisfy allOf[%d]: %s", index, describe(err))
			}
		}
	}
	for _, keyword := range []string{"anyOf", "oneOf"} {
		combinations, ok := schema[keyword].([]any)
		if !ok {
			continue
		}
		matches := 0
		for _, raw := range combinations {
			nested, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			if check(value, nested, root, path, depth+1) == nil {
				matches++
			}
		}
		if matches == 0 || (keyword == "oneOf" && matches > 1) {
			return fail(path, "does not satisfy %s", keyword)
		}
	}
	switch typed := value.(type) {
	case map[string]any:
		return checkObject(typed, schema, root, path, depth)
	case []any:
		return checkArray(typed, schema, root, path, depth)
	case string:
		return checkString(typed, schema, path)
	case float64:
		return checkNumber(typed, schema, path)
	}
	return nil
}

func checkObject(object map[string]any, schema, root map[string]any, path string, depth int) error {
	if required, ok := schema["required"].([]any); ok {
		for _, entry := range required {
			name, _ := entry.(string)
			if name == "" {
				continue
			}
			if _, present := object[name]; !present {
				return fail(path, "is missing the required property %q", name)
			}
		}
	}
	properties, _ := schema["properties"].(map[string]any)
	for name, raw := range properties {
		nested, ok := raw.(map[string]any)
		child, present := object[name]
		if !ok || !present {
			continue
		}
		if err := check(child, nested, root, path+"."+name, depth+1); err != nil {
			return err
		}
	}
	switch additional := schema["additionalProperties"].(type) {
	case bool:
		if !additional {
			for name := range object {
				if _, declared := properties[name]; !declared {
					return fail(path, "has the unexpected property %q", name)
				}
			}
		}
	case map[string]any:
		for name, child := range object {
			if _, declared := properties[name]; declared {
				continue
			}
			if err := check(child, additional, root, path+"."+name, depth+1); err != nil {
				return err
			}
		}
	}
	if limit, ok := integer(schema["minProperties"]); ok && len(object) < limit {
		return fail(path, "has fewer than %d properties", limit)
	}
	if limit, ok := integer(schema["maxProperties"]); ok && len(object) > limit {
		return fail(path, "has more than %d properties", limit)
	}
	return nil
}

func checkArray(items []any, schema, root map[string]any, path string, depth int) error {
	if limit, ok := integer(schema["minItems"]); ok && len(items) < limit {
		return fail(path, "has fewer than %d items", limit)
	}
	if limit, ok := integer(schema["maxItems"]); ok && len(items) > limit {
		return fail(path, "has more than %d items", limit)
	}
	nested, ok := schema["items"].(map[string]any)
	if !ok {
		return nil
	}
	for index, item := range items {
		if err := check(item, nested, root, fmt.Sprintf("%s[%d]", path, index), depth+1); err != nil {
			return err
		}
	}
	return nil
}

func checkString(text string, schema map[string]any, path string) error {
	length := len([]rune(text))
	if limit, ok := integer(schema["minLength"]); ok && length < limit {
		return fail(path, "is shorter than %d characters", limit)
	}
	if limit, ok := integer(schema["maxLength"]); ok && length > limit {
		return fail(path, "is longer than %d characters", limit)
	}
	if pattern, ok := schema["pattern"].(string); ok && pattern != "" {
		expression, err := regexp.Compile(pattern)
		if err != nil {
			return fail(path, "has a pattern that does not compile")
		}
		if !expression.MatchString(text) {
			return fail(path, "does not match the pattern")
		}
	}
	if format, ok := schema["format"].(string); ok && format == "uuid" && !uuidPattern.MatchString(text) {
		return fail(path, "is not a uuid")
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func checkNumber(number float64, schema map[string]any, path string) error {
	if limit, ok := schema["minimum"].(float64); ok && number < limit {
		return fail(path, "is below the minimum %v", limit)
	}
	if limit, ok := schema["maximum"].(float64); ok && number > limit {
		return fail(path, "is above the maximum %v", limit)
	}
	if limit, ok := schema["exclusiveMinimum"].(float64); ok && number <= limit {
		return fail(path, "is not above %v", limit)
	}
	if limit, ok := schema["exclusiveMaximum"].(float64); ok && number >= limit {
		return fail(path, "is not below %v", limit)
	}
	return nil
}

func checkType(value any, typed any, path string) error {
	var names []string
	switch declared := typed.(type) {
	case string:
		names = []string{declared}
	case []any:
		for _, entry := range declared {
			if name, ok := entry.(string); ok {
				names = append(names, name)
			}
		}
	}
	if len(names) == 0 {
		return nil
	}
	for _, name := range names {
		if isType(value, name) {
			return nil
		}
	}
	return fail(path, "is not a %s", strings.Join(names, " or "))
}

func isType(value any, name string) bool {
	switch name {
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "integer":
		number, ok := value.(float64)
		return ok && number == math.Trunc(number)
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "null":
		return value == nil
	}
	return false
}

func integer(raw any) (int, bool) {
	number, ok := raw.(float64)
	if !ok || number != math.Trunc(number) || number < 0 {
		return 0, false
	}
	return int(number), true
}

// resolve follows a local reference such as "#/$defs/Step".
func resolve(ref string, root map[string]any) (map[string]any, error) {
	rest, ok := strings.CutPrefix(ref, "#/")
	if !ok {
		return nil, errors.New("only local $ref values are supported")
	}
	var current any = root
	for _, part := range strings.Split(rest, "/") {
		part = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("$ref %q does not resolve", ref)
		}
		current, ok = object[part]
		if !ok {
			return nil, fmt.Errorf("$ref %q does not resolve", ref)
		}
	}
	target, ok := current.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("$ref %q is not a schema", ref)
	}
	return target, nil
}

// equal compares decoded JSON values structurally.
func equal(left, right any) bool {
	switch typedLeft := left.(type) {
	case map[string]any:
		typedRight, ok := right.(map[string]any)
		if !ok || len(typedLeft) != len(typedRight) {
			return false
		}
		for key, value := range typedLeft {
			other, present := typedRight[key]
			if !present || !equal(value, other) {
				return false
			}
		}
		return true
	case []any:
		typedRight, ok := right.([]any)
		if !ok || len(typedLeft) != len(typedRight) {
			return false
		}
		for index := range typedLeft {
			if !equal(typedLeft[index], typedRight[index]) {
				return false
			}
		}
		return true
	default:
		return left == right
	}
}

func describe(err error) string {
	var typed *Error
	if errors.As(err, &typed) {
		return typed.Message
	}
	return err.Error()
}

// Validate reports whether a schema document is one Check can apply: an
// object whose type names are known and whose nested schemas are objects.
// It is what a route answers 4xx from before a model is ever called.
func Validate(schema map[string]any) error {
	return validate(schema, "$", 0)
}

var knownTypes = map[string]bool{"object": true, "array": true, "string": true, "number": true, "integer": true, "boolean": true, "null": true}

func validate(schema map[string]any, path string, depth int) error {
	if depth > MaxDepth {
		return fail(path, "schema nests deeper than %d levels", MaxDepth)
	}
	switch typed := schema["type"].(type) {
	case nil:
	case string:
		if !knownTypes[typed] {
			return fail(path, "type %q is unknown", typed)
		}
	case []any:
		for _, entry := range typed {
			name, ok := entry.(string)
			if !ok || !knownTypes[name] {
				return fail(path, "type list contains an unknown type")
			}
		}
	default:
		return fail(path, "type is a string or a list of strings")
	}
	if pattern, ok := schema["pattern"].(string); ok {
		if _, err := regexp.Compile(pattern); err != nil {
			return fail(path, "pattern does not compile")
		}
	}
	if properties, ok := schema["properties"]; ok {
		object, ok := properties.(map[string]any)
		if !ok {
			return fail(path, "properties is an object")
		}
		for name, raw := range object {
			nested, ok := raw.(map[string]any)
			if !ok {
				return fail(path+"."+name, "is not a schema object")
			}
			if err := validate(nested, path+"."+name, depth+1); err != nil {
				return err
			}
		}
	}
	for _, keyword := range []string{"items", "additionalProperties"} {
		raw, ok := schema[keyword]
		if !ok {
			continue
		}
		switch nested := raw.(type) {
		case map[string]any:
			if err := validate(nested, path+"."+keyword, depth+1); err != nil {
				return err
			}
		case bool:
			if keyword == "items" {
				return fail(path, "items is a schema object")
			}
		default:
			return fail(path, "%s is a schema object", keyword)
		}
	}
	for _, keyword := range []string{"anyOf", "oneOf", "allOf"} {
		raw, ok := schema[keyword]
		if !ok {
			continue
		}
		list, ok := raw.([]any)
		if !ok || len(list) == 0 {
			return fail(path, "%s is a non-empty list of schemas", keyword)
		}
		for index, entry := range list {
			nested, ok := entry.(map[string]any)
			if !ok {
				return fail(fmt.Sprintf("%s.%s[%d]", path, keyword, index), "is not a schema object")
			}
			if err := validate(nested, fmt.Sprintf("%s.%s[%d]", path, keyword, index), depth+1); err != nil {
				return err
			}
		}
	}
	for _, keyword := range []string{"$defs", "definitions"} {
		raw, ok := schema[keyword]
		if !ok {
			continue
		}
		object, ok := raw.(map[string]any)
		if !ok {
			return fail(path, "%s is an object of schemas", keyword)
		}
		for name, entry := range object {
			nested, ok := entry.(map[string]any)
			if !ok {
				return fail(path+"."+keyword+"."+name, "is not a schema object")
			}
			if err := validate(nested, path+"."+keyword+"."+name, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
