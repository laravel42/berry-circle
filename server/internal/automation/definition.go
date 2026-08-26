// Package automation is the semantic model of a Berry workflow (product noun
// "Workflow", Go and SQL noun "automation"): the definition a person or the
// planner writes, the typed vocabulary of steps, the reference and condition
// grammar those steps use, the validator that decides whether a definition may
// be stored or activated, and the seams an execution engine plugs into.
//
// It knows no database and no provider SDK. Everything here is deterministic
// so the same definition validates the same way in a handler, in the planner
// and in a test.
package automation

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// DefinitionVersion is the only definition shape this package understands.
const DefinitionVersion = "1"

// MaxSteps bounds a definition. A workflow past this size is a plan, not an
// automation, and the graph walks below stay cheap.
const MaxSteps = 40

// MaxInstructionLength bounds an agent step's instruction.
const MaxInstructionLength = 20000

// TriggerType names how a workflow starts.
type TriggerType string

const (
	TriggerIntegration TriggerType = "integration"
	TriggerSchedule    TriggerType = "schedule"
	TriggerManual      TriggerType = "manual"
	TriggerBerryEvent  TriggerType = "berry_event"
	TriggerWebhook     TriggerType = "webhook"
)

// Valid reports whether the trigger type is part of the vocabulary.
func (kind TriggerType) Valid() bool {
	switch kind {
	case TriggerIntegration, TriggerSchedule, TriggerManual, TriggerBerryEvent, TriggerWebhook:
		return true
	}
	return false
}

// StepType is the constrained node vocabulary (spec §4).
type StepType string

const (
	StepAction      StepType = "action"
	StepCondition   StepType = "condition"
	StepSwitch      StepType = "switch"
	StepAgent       StepType = "agent"
	StepCreateIssue StepType = "create_issue"
	StepUpdateIssue StepType = "update_issue"
	StepApproval    StepType = "approval"
	StepWait        StepType = "wait"
	StepForeach     StepType = "foreach"
	StepTransform   StepType = "transform"
	StepSubworkflow StepType = "subworkflow"
)

// KnownStepTypes is the full vocabulary a definition may name.
var KnownStepTypes = map[StepType]bool{
	StepAction: true, StepCondition: true, StepSwitch: true, StepAgent: true,
	StepCreateIssue: true, StepUpdateIssue: true, StepApproval: true, StepWait: true,
	StepForeach: true, StepTransform: true, StepSubworkflow: true,
}

// SupportedStepTypes is the set Berry executes natively: the MVP set (spec
// §42) plus the extended nodes that landed with P4.5. A type in
// KnownStepTypes but not here parses, so a plan can carry it, and validation
// reports NODE_TYPE_UNSUPPORTED.
var SupportedStepTypes = map[StepType]bool{
	StepAction: true, StepCondition: true, StepAgent: true, StepCreateIssue: true,
	StepUpdateIssue: true, StepApproval: true, StepWait: true,
	StepSwitch: true, StepForeach: true, StepTransform: true, StepSubworkflow: true,
}

// Foreach bounds. A loop is a bounded fan-out, not a batch job: every item
// becomes one step row per body step, and a run walks them in order.
const (
	MaxForeachItems     = 100
	DefaultForeachItems = 25
)

// MaxSubworkflowDepth is how deep subworkflow runs may nest below the run a
// trigger started (depth 0): a child at 1, its child at 2, its child at 3.
const MaxSubworkflowDepth = 3

// ForeachBodyTypes are the step types a foreach body may contain. Branching
// and nested loops inside a loop stay out so an iteration is a straight
// walk; every body step may still wait (an approval, an agent run, a child
// workflow) because each iteration has its own rows.
var ForeachBodyTypes = map[StepType]bool{
	StepAction: true, StepAgent: true, StepCreateIssue: true, StepUpdateIssue: true,
	StepApproval: true, StepWait: true, StepTransform: true, StepSubworkflow: true,
}

// OnError names what the runner does when a step fails.
type OnError string

const (
	OnErrorFail OnError = "fail"
	OnErrorSkip OnError = "skip"
)

// IssueMode names how an agent step runs.
type IssueMode string

const (
	// IssueModeInline sends one bounded message to the agent and consumes the
	// reply in the next step; the Berry-minted ledger id is the step run.
	IssueModeInline IssueMode = "inline"
	// IssueModeIssue creates a board issue and waits for its run to complete.
	IssueModeIssue IssueMode = "issue"
)

// WaitMode names what a wait step waits for.
type WaitMode string

const (
	WaitModeDuration WaitMode = "duration"
	WaitModeUntil    WaitMode = "until"
	WaitModeEvent    WaitMode = "event"
)

// ApproverType names who resolves an approval step.
type ApproverType string

const (
	ApproverUser ApproverType = "user"
	ApproverRole ApproverType = "role"
)

var (
	stepIDPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	stepRunIDPattern = regexp.MustCompile(`^([a-z][a-z0-9_]{0,63})(?:\[([0-9]{1,3})\])?$`)
)

// ValidStepID reports whether an id matches the step id grammar of a
// definition.
func ValidStepID(id string) bool {
	return stepIDPattern.MatchString(id)
}

// ValidStepRunID reports whether an id matches what automation_step_runs
// stores: a step id, or a step id with a foreach index suffix ("body[2]").
func ValidStepRunID(id string) bool {
	return stepRunIDPattern.MatchString(id)
}

// IndexedStepID names the row a foreach body step gets for one item.
func IndexedStepID(id string, index int) string {
	return id + "[" + strconv.Itoa(index) + "]"
}

// SplitStepRunID separates a stored step id into the definition's step id
// and, for a foreach body row, the item index. indexed is false for a plain
// step id; the index is then -1.
func SplitStepRunID(id string) (base string, index int, indexed bool) {
	match := stepRunIDPattern.FindStringSubmatch(id)
	if match == nil {
		return id, -1, false
	}
	if match[2] == "" {
		return match[1], -1, false
	}
	index, _ = strconv.Atoi(match[2])
	return match[1], index, true
}

// Definition is WorkflowDefinition v1, the shape stored in
// automations.definition. Layout never lives here.
type Definition struct {
	Version string   `json:"version"`
	Trigger Trigger  `json:"trigger"`
	Steps   []Step   `json:"steps"`
	Entry   []string `json:"entry"`
}

// Trigger is how a workflow starts.
type Trigger struct {
	ID        string         `json:"id"`
	Type      TriggerType    `json:"type"`
	Provider  string         `json:"provider,omitempty"`
	Operation string         `json:"operation,omitempty"`
	Event     string         `json:"event,omitempty"`
	Config    *TriggerConfig `json:"config,omitempty"`
}

// TriggerConfig carries the per-type settings.
type TriggerConfig struct {
	Cron     string     `json:"cron,omitempty"`
	Timezone string     `json:"timezone,omitempty"`
	Filter   *Condition `json:"filter,omitempty"`
}

// stepHeader is what every step carries regardless of type.
type stepHeader struct {
	ID        string   `json:"id"`
	Type      StepType `json:"type"`
	DependsOn []string `json:"dependsOn,omitempty"`
	OnError   OnError  `json:"onError,omitempty"`
}

// Step is one node. Exactly one of the typed pointers is set, selected by
// Type; the header fields are shared by every type.
type Step struct {
	ID        string
	Type      StepType
	DependsOn []string
	OnError   OnError

	Action      *ActionStep
	Condition   *ConditionStep
	Switch      *SwitchStep
	Agent       *AgentStep
	CreateIssue *CreateIssueStep
	UpdateIssue *UpdateIssueStep
	Approval    *ApprovalStep
	Wait        *WaitStep
	Foreach     *ForeachStep
	Transform   *TransformStep
	Subworkflow *SubworkflowStep
}

// ActionStep calls one provider tool.
type ActionStep struct {
	stepHeader
	Provider  string                     `json:"provider"`
	Operation string                     `json:"operation"`
	Input     map[string]json.RawMessage `json:"input,omitempty"`
}

// ConditionStep branches on a typed expression.
type ConditionStep struct {
	stepHeader
	Expression Condition `json:"expression"`
	TrueSteps  []string  `json:"trueSteps"`
	FalseSteps []string  `json:"falseSteps,omitempty"`
}

// SwitchCase is one branch of a switch step.
type SwitchCase struct {
	Equals json.RawMessage `json:"equals"`
	Steps  []string        `json:"steps"`
}

// SwitchStep (P4.5) branches on a value.
type SwitchStep struct {
	stepHeader
	Value        json.RawMessage `json:"value"`
	Cases        []SwitchCase    `json:"cases"`
	DefaultSteps []string        `json:"defaultSteps,omitempty"`
}

// AgentStep asks a workspace agent for bounded reasoning.
type AgentStep struct {
	stepHeader
	AgentID              string                     `json:"agentId,omitempty"`
	RequiredCapabilities []string                   `json:"requiredCapabilities,omitempty"`
	Instruction          string                     `json:"instruction"`
	Input                map[string]json.RawMessage `json:"input,omitempty"`
	OutputSchema         json.RawMessage            `json:"outputSchema,omitempty"`
	IssueMode            IssueMode                  `json:"issueMode,omitempty"`
}

// CreateIssueStep creates a board issue.
type CreateIssueStep struct {
	stepHeader
	Title             string `json:"title"`
	Description       string `json:"description,omitempty"`
	AssignAgentID     string `json:"assignAgentId,omitempty"`
	Priority          string `json:"priority,omitempty"`
	GoalID            string `json:"goalId,omitempty"`
	BoardID           string `json:"boardId,omitempty"`
	WaitForCompletion bool   `json:"waitForCompletion,omitempty"`
}

// IssuePatch is the typed patch an update_issue step applies.
type IssuePatch struct {
	Status        *string `json:"status,omitempty"`
	Priority      *string `json:"priority,omitempty"`
	AssignAgentID *string `json:"assignAgentId,omitempty"`
	Title         *string `json:"title,omitempty"`
	Description   *string `json:"description,omitempty"`
}

// Empty reports whether the patch changes nothing.
func (patch IssuePatch) Empty() bool {
	return patch.Status == nil && patch.Priority == nil && patch.AssignAgentID == nil &&
		patch.Title == nil && patch.Description == nil
}

// UpdateIssueStep patches an existing issue named by reference or template.
type UpdateIssueStep struct {
	stepHeader
	Issue json.RawMessage `json:"issue"`
	Patch IssuePatch      `json:"patch"`
}

// Approver names who may resolve an approval.
type Approver struct {
	Type   ApproverType `json:"type"`
	UserID string       `json:"userId,omitempty"`
	Role   string       `json:"role,omitempty"`
}

// ApprovalStep pauses the run until a person decides.
type ApprovalStep struct {
	stepHeader
	Title       string   `json:"title"`
	Description string   `json:"description,omitempty"`
	Approver    Approver `json:"approver"`
	Timeout     string   `json:"timeout,omitempty"`
}

// WaitEvent is the event a wait step resumes on.
type WaitEvent struct {
	Provider string     `json:"provider"`
	Event    string     `json:"event"`
	Filter   *Condition `json:"filter,omitempty"`
}

// WaitStep pauses for a duration, until an instant, or for an event.
type WaitStep struct {
	stepHeader
	Mode     WaitMode   `json:"mode"`
	Duration string     `json:"duration,omitempty"`
	Until    string     `json:"until,omitempty"`
	Event    *WaitEvent `json:"event,omitempty"`
}

// ForeachStep (P4.5) runs a body per item.
type ForeachStep struct {
	stepHeader
	Items    json.RawMessage `json:"items"`
	Steps    []string        `json:"steps"`
	MaxItems int             `json:"maxItems,omitempty"`
}

// TransformStep (P4.5) reshapes values.
type TransformStep struct {
	stepHeader
	Output map[string]json.RawMessage `json:"output"`
}

// SubworkflowStep (P4.5) runs another workflow.
type SubworkflowStep struct {
	stepHeader
	WorkflowID string                     `json:"workflowId"`
	Input      map[string]json.RawMessage `json:"input,omitempty"`
}

// FieldError is one validation finding at a JSON pointer inside the
// definition (paths start at "/", the handler prefixes "/definition").
type FieldError struct {
	Path     string   `json:"path"`
	Code     string   `json:"code"`
	Message  string   `json:"message"`
	Severity Severity `json:"severity"`
	Hint     string   `json:"hint,omitempty"`
}

// Severity distinguishes what blocks a write from what a person should see.
type Severity string

const (
	SeverityError   Severity = "error"
	SeverityWarning Severity = "warning"
)

func fieldError(path, code, message string) FieldError {
	return FieldError{Path: path, Code: code, Message: message, Severity: SeverityError}
}

// ParseDefinition decodes a definition strictly: unknown fields, unknown step
// types and malformed steps are findings with a path, never a silently
// dropped key. A non-empty findings list means the definition must not be
// stored. Shape is all it checks; ValidateDefinition owns every rule about
// what the shape says, the version included.
func ParseDefinition(raw []byte) (Definition, []FieldError) {
	var header struct {
		Version string            `json:"version"`
		Trigger json.RawMessage   `json:"trigger"`
		Steps   []json.RawMessage `json:"steps"`
		Entry   []string          `json:"entry"`
	}
	if err := decodeStrict(raw, &header); err != nil {
		return Definition{}, []FieldError{fieldError("", "DEFINITION_INVALID_JSON", describeDecodeError(err))}
	}
	var findings []FieldError
	definition := Definition{Version: header.Version, Entry: header.Entry}
	if len(header.Trigger) == 0 || bytes.Equal(bytes.TrimSpace(header.Trigger), []byte("null")) {
		findings = append(findings, fieldError("/trigger", "WORKFLOW_TRIGGER_REQUIRED", "A workflow needs a trigger."))
	} else if err := decodeStrict(header.Trigger, &definition.Trigger); err != nil {
		findings = append(findings, fieldError("/trigger", "DEFINITION_INVALID_JSON", describeDecodeError(err)))
	}
	definition.Steps = make([]Step, 0, len(header.Steps))
	for index, encoded := range header.Steps {
		path := "/steps/" + strconv.Itoa(index)
		step, stepFindings := parseStep(encoded, path)
		findings = append(findings, stepFindings...)
		definition.Steps = append(definition.Steps, step)
	}
	return definition, findings
}

func parseStep(encoded json.RawMessage, path string) (Step, []FieldError) {
	var header stepHeader
	if err := json.Unmarshal(encoded, &header); err != nil {
		return Step{}, []FieldError{fieldError(path, "DEFINITION_INVALID_JSON", describeDecodeError(err))}
	}
	step := Step{ID: header.ID, Type: header.Type, DependsOn: header.DependsOn, OnError: header.OnError}
	if !KnownStepTypes[header.Type] {
		return step, []FieldError{fieldError(path+"/type", "STEP_TYPE_INVALID",
			fmt.Sprintf("Step type %q is not part of the workflow vocabulary.", header.Type))}
	}
	var target any
	switch header.Type {
	case StepAction:
		step.Action = &ActionStep{}
		target = step.Action
	case StepCondition:
		step.Condition = &ConditionStep{}
		target = step.Condition
	case StepSwitch:
		step.Switch = &SwitchStep{}
		target = step.Switch
	case StepAgent:
		step.Agent = &AgentStep{}
		target = step.Agent
	case StepCreateIssue:
		step.CreateIssue = &CreateIssueStep{}
		target = step.CreateIssue
	case StepUpdateIssue:
		step.UpdateIssue = &UpdateIssueStep{}
		target = step.UpdateIssue
	case StepApproval:
		step.Approval = &ApprovalStep{}
		target = step.Approval
	case StepWait:
		step.Wait = &WaitStep{}
		target = step.Wait
	case StepForeach:
		step.Foreach = &ForeachStep{}
		target = step.Foreach
	case StepTransform:
		step.Transform = &TransformStep{}
		target = step.Transform
	case StepSubworkflow:
		step.Subworkflow = &SubworkflowStep{}
		target = step.Subworkflow
	}
	if err := decodeStrict(encoded, target); err != nil {
		return step, []FieldError{fieldError(path, "STEP_FIELD_INVALID", describeDecodeError(err))}
	}
	return step, nil
}

// UnmarshalJSON lets a Definition decode through encoding/json; strict
// findings are collapsed into the first error.
func (step *Step) UnmarshalJSON(encoded []byte) error {
	parsed, findings := parseStep(encoded, "")
	if len(findings) > 0 {
		return errors.New(findings[0].Message)
	}
	*step = parsed
	return nil
}

// MarshalJSON writes the typed step back as one object.
func (step Step) MarshalJSON() ([]byte, error) {
	header := stepHeader{ID: step.ID, Type: step.Type, DependsOn: step.DependsOn, OnError: step.OnError}
	var body any
	switch step.Type {
	case StepAction:
		value := *step.Action
		value.stepHeader = header
		body = value
	case StepCondition:
		value := *step.Condition
		value.stepHeader = header
		body = value
	case StepSwitch:
		value := *step.Switch
		value.stepHeader = header
		body = value
	case StepAgent:
		value := *step.Agent
		value.stepHeader = header
		body = value
	case StepCreateIssue:
		value := *step.CreateIssue
		value.stepHeader = header
		body = value
	case StepUpdateIssue:
		value := *step.UpdateIssue
		value.stepHeader = header
		body = value
	case StepApproval:
		value := *step.Approval
		value.stepHeader = header
		body = value
	case StepWait:
		value := *step.Wait
		value.stepHeader = header
		body = value
	case StepForeach:
		value := *step.Foreach
		value.stepHeader = header
		body = value
	case StepTransform:
		value := *step.Transform
		value.stepHeader = header
		body = value
	case StepSubworkflow:
		value := *step.Subworkflow
		value.stepHeader = header
		body = value
	default:
		return nil, fmt.Errorf("step %q has unknown type %q", step.ID, step.Type)
	}
	return json.Marshal(body)
}

// Children returns the step ids this step hands control to directly:
// condition branches, switch cases and foreach bodies. Sequencing through
// dependsOn is the reverse relation and lives on the dependent step.
func (step Step) Children() []string {
	var children []string
	switch step.Type {
	case StepCondition:
		if step.Condition != nil {
			children = append(children, step.Condition.TrueSteps...)
			children = append(children, step.Condition.FalseSteps...)
		}
	case StepSwitch:
		if step.Switch != nil {
			for _, branch := range step.Switch.Cases {
				children = append(children, branch.Steps...)
			}
			children = append(children, step.Switch.DefaultSteps...)
		}
	case StepForeach:
		if step.Foreach != nil {
			children = append(children, step.Foreach.Steps...)
		}
	}
	return children
}

func decodeStrict(encoded []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}

// describeDecodeError keeps the decoder's field-level hint ("unknown field
// \"foo\"") without echoing the input.
func describeDecodeError(err error) string {
	var syntax *json.SyntaxError
	if errors.As(err, &syntax) {
		return "The definition is not valid JSON."
	}
	var typed *json.UnmarshalTypeError
	if errors.As(err, &typed) {
		if typed.Field != "" {
			return fmt.Sprintf("Field %q has the wrong type.", typed.Field)
		}
		return "A value has the wrong type."
	}
	return err.Error()
}
