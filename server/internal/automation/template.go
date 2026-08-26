package automation

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// referencePattern is the grammar of a value reference (spec §4 templates):
// the trigger payload, a predecessor's output, non-secret connection metadata,
// the goal, or the current foreach item, each followed by a property path.
var referencePattern = regexp.MustCompile(
	`^(trigger|steps\.[a-z][a-z0-9_]{0,63}\.output|connections\.[a-z0-9_]+|goal|item)(\.[A-Za-z0-9_]+)*$`,
)

// ValidReference reports whether a reference path matches the grammar.
func ValidReference(ref string) bool {
	return referencePattern.MatchString(ref)
}

// ReferencedStep returns the step a "steps.<id>.output…" reference reads from.
func ReferencedStep(ref string) (string, bool) {
	if !strings.HasPrefix(ref, "steps.") {
		return "", false
	}
	rest := strings.TrimPrefix(ref, "steps.")
	id, _, _ := strings.Cut(rest, ".")
	return id, id != ""
}

// Reference is the {"ref": "path"} object form of a value reference.
type Reference struct {
	Ref string `json:"ref"`
}

// ParseReference recognises a JSON value that is exactly {"ref": "…"}.
func ParseReference(raw json.RawMessage) (Reference, bool) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || len(object) != 1 {
		return Reference{}, false
	}
	encoded, ok := object["ref"]
	if !ok {
		return Reference{}, false
	}
	var ref string
	if json.Unmarshal(encoded, &ref) != nil {
		return Reference{}, false
	}
	return Reference{Ref: ref}, true
}

// Segment is one piece of a template: literal text or a reference.
type Segment struct {
	Literal string
	Ref     string
}

// ParseTemplate splits "Hello {{ trigger.name }}" into segments. A placeholder
// that never closes or names an invalid path is an error, because rendering
// it would either leak the braces or read nothing.
func ParseTemplate(text string) ([]Segment, error) {
	var segments []Segment
	rest := text
	for {
		start := strings.Index(rest, "{{")
		if start < 0 {
			if rest != "" {
				segments = append(segments, Segment{Literal: rest})
			}
			return segments, nil
		}
		if start > 0 {
			segments = append(segments, Segment{Literal: rest[:start]})
		}
		rest = rest[start+2:]
		end := strings.Index(rest, "}}")
		if end < 0 {
			return nil, errors.New("template placeholder is not closed")
		}
		ref := strings.TrimSpace(rest[:end])
		if !ValidReference(ref) {
			return nil, fmt.Errorf("template reference %q is invalid", ref)
		}
		segments = append(segments, Segment{Ref: ref})
		rest = rest[end+2:]
	}
}

// TemplateReferences lists every reference a template names.
func TemplateReferences(text string) ([]string, error) {
	segments, err := ParseTemplate(text)
	if err != nil {
		return nil, err
	}
	var refs []string
	for _, segment := range segments {
		if segment.Ref != "" {
			refs = append(refs, segment.Ref)
		}
	}
	return refs, nil
}

// Scope is the value tree references resolve against at run time. Keys are
// the reference roots: trigger, steps (id → {"output": …}), connections,
// goal and item.
type Scope map[string]any

// Resolve walks a dotted reference through the scope.
func (scope Scope) Resolve(ref string) (any, bool) {
	if !ValidReference(ref) {
		return nil, false
	}
	var current any = map[string]any(scope)
	for _, part := range strings.Split(ref, ".") {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

// Render substitutes every placeholder. A reference that resolves to nothing
// is an error rather than an empty string, so a misnamed field never ships a
// blank into a provider.
func Render(text string, scope Scope) (string, error) {
	segments, err := ParseTemplate(text)
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	for _, segment := range segments {
		if segment.Ref == "" {
			builder.WriteString(segment.Literal)
			continue
		}
		value, ok := scope.Resolve(segment.Ref)
		if !ok {
			return "", fmt.Errorf("template reference %q resolves to nothing", segment.Ref)
		}
		builder.WriteString(stringify(value))
	}
	return builder.String(), nil
}

// ResolveValue turns one input value into its runtime value: a reference
// object resolves through the scope, a string renders as a template, objects
// and arrays resolve recursively, and primitives pass through.
func ResolveValue(raw json.RawMessage, scope Scope) (any, error) {
	if ref, ok := ParseReference(raw); ok {
		value, found := scope.Resolve(ref.Ref)
		if !found {
			return nil, fmt.Errorf("reference %q resolves to nothing", ref.Ref)
		}
		return value, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, errors.New("value is not valid JSON")
	}
	return resolveDecoded(decoded, scope)
}

func resolveDecoded(value any, scope Scope) (any, error) {
	switch typed := value.(type) {
	case string:
		return Render(typed, scope)
	case map[string]any:
		if ref, ok := decodedReference(typed); ok {
			resolved, found := scope.Resolve(ref)
			if !found {
				return nil, fmt.Errorf("reference %q resolves to nothing", ref)
			}
			return resolved, nil
		}
		result := make(map[string]any, len(typed))
		for key, nested := range typed {
			resolved, err := resolveDecoded(nested, scope)
			if err != nil {
				return nil, err
			}
			result[key] = resolved
		}
		return result, nil
	case []any:
		result := make([]any, 0, len(typed))
		for _, nested := range typed {
			resolved, err := resolveDecoded(nested, scope)
			if err != nil {
				return nil, err
			}
			result = append(result, resolved)
		}
		return result, nil
	default:
		return value, nil
	}
}

// ValueReferences lists every reference a JSON value names, through reference
// objects and template strings at any depth. Invalid references are returned
// as errors so the validator can point at them.
func ValueReferences(raw json.RawMessage) ([]string, error) {
	if ref, ok := ParseReference(raw); ok {
		if !ValidReference(ref.Ref) {
			return nil, fmt.Errorf("reference %q is invalid", ref.Ref)
		}
		return []string{ref.Ref}, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, errors.New("value is not valid JSON")
	}
	return decodedReferences(decoded)
}

func decodedReferences(value any) ([]string, error) {
	switch typed := value.(type) {
	case string:
		return TemplateReferences(typed)
	case map[string]any:
		if ref, ok := decodedReference(typed); ok {
			if !ValidReference(ref) {
				return nil, fmt.Errorf("reference %q is invalid", ref)
			}
			return []string{ref}, nil
		}
		var refs []string
		for _, nested := range typed {
			found, err := decodedReferences(nested)
			if err != nil {
				return nil, err
			}
			refs = append(refs, found...)
		}
		return refs, nil
	case []any:
		var refs []string
		for _, nested := range typed {
			found, err := decodedReferences(nested)
			if err != nil {
				return nil, err
			}
			refs = append(refs, found...)
		}
		return refs, nil
	default:
		return nil, nil
	}
}

// decodedReference recognises the {"ref": "…"} shape inside a decoded value.
func decodedReference(object map[string]any) (string, bool) {
	if len(object) != 1 {
		return "", false
	}
	ref, ok := object["ref"].(string)
	return ref, ok
}

func stringify(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}
