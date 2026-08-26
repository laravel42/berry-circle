package automation

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

// Operator is the typed expression vocabulary. No code, no JavaScript.
type Operator string

const (
	OpEquals      Operator = "equals"
	OpNotEquals   Operator = "not_equals"
	OpGreaterThan Operator = "greater_than"
	OpLessThan    Operator = "less_than"
	OpGte         Operator = "gte"
	OpLte         Operator = "lte"
	OpContains    Operator = "contains"
	OpExists      Operator = "exists"
	OpAnd         Operator = "and"
	OpOr          Operator = "or"
	OpNot         Operator = "not"
)

const maxLogicalArgs = 10

// Condition is a ConditionExpression: comparisons carry left and right,
// exists carries a reference on the left, and/or/not carry args.
type Condition struct {
	Op    Operator        `json:"op"`
	Left  json.RawMessage `json:"left,omitempty"`
	Right json.RawMessage `json:"right,omitempty"`
	Args  []Condition     `json:"args,omitempty"`
}

func (operator Operator) comparison() bool {
	switch operator {
	case OpEquals, OpNotEquals, OpGreaterThan, OpLessThan, OpGte, OpLte, OpContains:
		return true
	}
	return false
}

func (operator Operator) logical() bool {
	return operator == OpAnd || operator == OpOr || operator == OpNot
}

// Validate checks operand shape. The path is the JSON pointer of this
// expression inside the definition.
func (condition Condition) Validate(path string) []FieldError {
	var findings []FieldError
	switch {
	case condition.Op.comparison():
		if len(condition.Left) == 0 || len(condition.Right) == 0 {
			findings = append(findings, fieldError(path, "CONDITION_OPERANDS_INVALID",
				fmt.Sprintf("Operator %q needs both left and right operands.", condition.Op)))
		}
		if len(condition.Args) > 0 {
			findings = append(findings, fieldError(path+"/args", "CONDITION_OPERANDS_INVALID",
				fmt.Sprintf("Operator %q does not take args.", condition.Op)))
		}
	case condition.Op == OpExists:
		if _, ok := ParseReference(condition.Left); !ok {
			findings = append(findings, fieldError(path+"/left", "CONDITION_OPERANDS_INVALID",
				"Operator \"exists\" needs a reference on the left."))
		}
		if len(condition.Right) > 0 || len(condition.Args) > 0 {
			findings = append(findings, fieldError(path, "CONDITION_OPERANDS_INVALID",
				"Operator \"exists\" takes only a left reference."))
		}
	case condition.Op.logical():
		if len(condition.Left) > 0 || len(condition.Right) > 0 {
			findings = append(findings, fieldError(path, "CONDITION_OPERANDS_INVALID",
				fmt.Sprintf("Operator %q takes args, not operands.", condition.Op)))
		}
		switch {
		case condition.Op == OpNot && len(condition.Args) != 1:
			findings = append(findings, fieldError(path+"/args", "CONDITION_OPERANDS_INVALID",
				"Operator \"not\" takes exactly one argument."))
		case condition.Op != OpNot && (len(condition.Args) < 1 || len(condition.Args) > maxLogicalArgs):
			findings = append(findings, fieldError(path+"/args", "CONDITION_OPERANDS_INVALID",
				fmt.Sprintf("Operator %q takes between 1 and %d arguments.", condition.Op, maxLogicalArgs)))
		}
		for index, argument := range condition.Args {
			findings = append(findings, argument.Validate(fmt.Sprintf("%s/args/%d", path, index))...)
		}
	default:
		findings = append(findings, fieldError(path+"/op", "CONDITION_OPERANDS_INVALID",
			fmt.Sprintf("Operator %q is not part of the expression vocabulary.", condition.Op)))
	}
	for _, operand := range []struct {
		name string
		raw  json.RawMessage
	}{{"left", condition.Left}, {"right", condition.Right}} {
		if len(operand.raw) == 0 {
			continue
		}
		if _, err := ValueReferences(operand.raw); err != nil {
			findings = append(findings, fieldError(path+"/"+operand.name, "TEMPLATE_REF_INVALID", err.Error()))
		}
	}
	return findings
}

// References lists every reference the expression reads, at any depth.
func (condition Condition) References() []string {
	var refs []string
	for _, operand := range []json.RawMessage{condition.Left, condition.Right} {
		if len(operand) == 0 {
			continue
		}
		found, err := ValueReferences(operand)
		if err == nil {
			refs = append(refs, found...)
		}
	}
	for _, argument := range condition.Args {
		refs = append(refs, argument.References()...)
	}
	return refs
}

// Evaluate resolves the expression against a scope. A comparison between
// values of different kinds is an error, not false, so a misrouted field is
// noticed rather than silently taking the false branch.
func Evaluate(condition Condition, scope Scope) (bool, error) {
	switch condition.Op {
	case OpAnd:
		for _, argument := range condition.Args {
			result, err := Evaluate(argument, scope)
			if err != nil || !result {
				return false, err
			}
		}
		return len(condition.Args) > 0, nil
	case OpOr:
		for _, argument := range condition.Args {
			result, err := Evaluate(argument, scope)
			if err != nil {
				return false, err
			}
			if result {
				return true, nil
			}
		}
		return false, nil
	case OpNot:
		if len(condition.Args) != 1 {
			return false, errors.New("not takes exactly one argument")
		}
		result, err := Evaluate(condition.Args[0], scope)
		return !result, err
	case OpExists:
		ref, ok := ParseReference(condition.Left)
		if !ok {
			return false, errors.New("exists needs a reference")
		}
		value, found := scope.Resolve(ref.Ref)
		return found && value != nil, nil
	}
	if !condition.Op.comparison() {
		return false, fmt.Errorf("unknown operator %q", condition.Op)
	}
	left, err := ResolveValue(condition.Left, scope)
	if err != nil {
		return false, err
	}
	right, err := ResolveValue(condition.Right, scope)
	if err != nil {
		return false, err
	}
	switch condition.Op {
	case OpEquals:
		return reflect.DeepEqual(left, right), nil
	case OpNotEquals:
		return !reflect.DeepEqual(left, right), nil
	case OpContains:
		return contains(left, right)
	}
	leftNumber, leftOK := left.(float64)
	rightNumber, rightOK := right.(float64)
	if leftOK && rightOK {
		switch condition.Op {
		case OpGreaterThan:
			return leftNumber > rightNumber, nil
		case OpLessThan:
			return leftNumber < rightNumber, nil
		case OpGte:
			return leftNumber >= rightNumber, nil
		case OpLte:
			return leftNumber <= rightNumber, nil
		}
	}
	leftText, leftOK := left.(string)
	rightText, rightOK := right.(string)
	if leftOK && rightOK {
		comparison := strings.Compare(leftText, rightText)
		switch condition.Op {
		case OpGreaterThan:
			return comparison > 0, nil
		case OpLessThan:
			return comparison < 0, nil
		case OpGte:
			return comparison >= 0, nil
		case OpLte:
			return comparison <= 0, nil
		}
	}
	return false, fmt.Errorf("operator %q needs two numbers or two strings", condition.Op)
}

func contains(haystack, needle any) (bool, error) {
	switch typed := haystack.(type) {
	case string:
		text, ok := needle.(string)
		if !ok {
			return false, errors.New("contains on a string needs a string")
		}
		return strings.Contains(typed, text), nil
	case []any:
		for _, item := range typed {
			if reflect.DeepEqual(item, needle) {
				return true, nil
			}
		}
		return false, nil
	case map[string]any:
		key, ok := needle.(string)
		if !ok {
			return false, errors.New("contains on an object needs a key")
		}
		_, found := typed[key]
		return found, nil
	default:
		return false, errors.New("contains needs a string, array or object on the left")
	}
}
