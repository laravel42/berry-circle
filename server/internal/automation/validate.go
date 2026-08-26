package automation

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	// Timezone validation must not depend on the host having tzdata; the
	// server may run in a scratch container.
	_ "time/tzdata"

	"github.com/google/uuid"
)

// ToolKind distinguishes what a provider tool is used for in a definition.
type ToolKind string

const (
	ToolTrigger ToolKind = "trigger"
	ToolAction  ToolKind = "action"
)

// ToolSpec is what the validator needs to know about one provider tool. It is
// a projection of the integration registry so this package never imports it.
type ToolSpec struct {
	Provider  string
	Operation string
	Kind      ToolKind
	// ConnectionRequired is false for providers Berry executes itself.
	ConnectionRequired bool
	// RequiresApproval means a human must decide before the call, by policy
	// or by the tool's own declaration.
	RequiresApproval bool
	// Destructive removes or irreversibly alters something.
	Destructive bool
	// InputSchema and OutputSchema are JSON Schema documents; nil means unknown.
	InputSchema  map[string]any
	OutputSchema map[string]any
}

// Catalog answers the validator's questions about providers. A nil catalog
// skips every integration rule, which is how a definition is checked for
// shape before the registry is consulted.
type Catalog interface {
	Tool(provider, operation string, kind ToolKind) (ToolSpec, bool)
	Connected(provider string) bool
}

// ValidateOptions tunes one validation.
type ValidateOptions struct {
	Catalog Catalog
	// RequireConnections makes a missing connection an error, which is the
	// activation rule; saving a draft only warns.
	RequireConnections bool
	// Supported overrides SupportedStepTypes when set.
	Supported map[StepType]bool
}

// Report is the outcome of a validation. Errors block the write; warnings are
// shown to the person and stored beside the definition.
type Report struct {
	Errors   []FieldError `json:"errors"`
	Warnings []FieldError `json:"warnings"`
}

// Valid reports whether the definition may be stored.
func (report Report) Valid() bool {
	return len(report.Errors) == 0
}

func (report *Report) add(finding FieldError) {
	if finding.Severity == SeverityWarning {
		report.Warnings = append(report.Warnings, finding)
		return
	}
	report.Errors = append(report.Errors, finding)
}

func (report *Report) errorf(path, code, message string) {
	report.add(fieldError(path, code, message))
}

func (report *Report) warnf(path, code, message string) {
	finding := fieldError(path, code, message)
	finding.Severity = SeverityWarning
	report.add(finding)
}

var (
	capabilityPattern = regexp.MustCompile(`^[a-z0-9-]{1,50}$`)
	durationPattern   = regexp.MustCompile(`^P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$`)
	cronFieldPattern  = regexp.MustCompile(`^[0-9*,/\-]+$`)
)

var issuePriorities = map[string]bool{"none": true, "low": true, "medium": true, "high": true, "urgent": true}

var issueStatuses = map[string]bool{
	"backlog": true, "todo": true, "inProgress": true, "inReview": true,
	"done": true, "cancelled": true, "blocked": true,
}

var workspaceRoles = map[string]bool{"owner": true, "admin": true, "member": true}

// ValidDuration reports whether text is an ISO-8601 duration of the subset a
// workflow uses (days, hours, minutes, seconds, or whole weeks).
func ValidDuration(text string) bool {
	return text != "P" && text != "PT" && durationPattern.MatchString(text)
}

// ValidCronExpression is a syntactic check on a five-field expression or one
// of the named schedules. The parser that computes fire times lands with
// schedule triggers; until then a malformed expression is still refused here.
func ValidCronExpression(expression string) bool {
	switch expression {
	case "@hourly", "@daily", "@weekly", "@monthly", "@yearly":
		return true
	}
	fields := strings.Fields(expression)
	if len(fields) != 5 {
		return false
	}
	for _, field := range fields {
		if !cronFieldPattern.MatchString(field) {
			return false
		}
	}
	return true
}

// ValidateDefinition runs the structural, workflow, integration (with a
// catalog) and safety rules over one definition. The result is deterministic
// for a given definition and catalog.
func ValidateDefinition(definition Definition, options ValidateOptions) Report {
	var report Report
	supported := options.Supported
	if supported == nil {
		supported = SupportedStepTypes
	}
	if definition.Version != DefinitionVersion {
		report.errorf("/version", "DEFINITION_VERSION_UNSUPPORTED",
			fmt.Sprintf("Definition version %q is not supported; use %q.", definition.Version, DefinitionVersion))
	}
	validateTrigger(definition.Trigger, options, &report)

	if len(definition.Steps) == 0 {
		report.errorf("/steps", "WORKFLOW_EMPTY", "A workflow needs at least one step.")
	}
	if len(definition.Steps) > MaxSteps {
		report.errorf("/steps", "PLAN_TOO_LARGE",
			fmt.Sprintf("A workflow may have at most %d steps.", MaxSteps))
	}
	index := make(map[string]int, len(definition.Steps))
	for position, step := range definition.Steps {
		path := stepPath(position)
		switch {
		case !ValidStepID(step.ID):
			report.errorf(path+"/id", "STEP_ID_INVALID",
				"Step ids are lowercase letters, digits and underscores, starting with a letter.")
		case step.ID == definition.Trigger.ID:
			report.errorf(path+"/id", "STEP_ID_DUPLICATE", fmt.Sprintf("Step id %q is the trigger id.", step.ID))
		default:
			if _, exists := index[step.ID]; exists {
				report.errorf(path+"/id", "STEP_ID_DUPLICATE", fmt.Sprintf("Step id %q is used twice.", step.ID))
			} else {
				index[step.ID] = position
			}
		}
		if !KnownStepTypes[step.Type] {
			report.errorf(path+"/type", "STEP_TYPE_INVALID",
				fmt.Sprintf("Step type %q is not part of the workflow vocabulary.", step.Type))
		} else if !supported[step.Type] {
			report.add(FieldError{
				Path: path + "/type", Code: "NODE_TYPE_UNSUPPORTED", Severity: SeverityError,
				Message: fmt.Sprintf("Step type %q cannot be executed yet.", step.Type),
				Hint:    "Use action, condition, agent, create_issue, update_issue, approval or wait.",
			})
		}
		if step.OnError != "" && step.OnError != OnErrorFail && step.OnError != OnErrorSkip {
			report.errorf(path+"/onError", "STEP_FIELD_INVALID", "onError is \"fail\" or \"skip\".")
		}
	}

	if len(definition.Entry) == 0 && len(definition.Steps) > 0 {
		report.errorf("/entry", "WORKFLOW_ENTRY_INVALID", "entry names the steps that run first.")
	}
	for position, id := range definition.Entry {
		if _, ok := index[id]; !ok {
			report.errorf("/entry/"+strconv.Itoa(position), "WORKFLOW_ENTRY_INVALID",
				fmt.Sprintf("Entry step %q does not exist.", id))
		}
	}

	graph := buildGraph(definition, index, &report)
	reachable := graph.reachable(definition.Entry)
	for position, step := range definition.Steps {
		if _, known := index[step.ID]; known && index[step.ID] == position && !reachable[step.ID] {
			report.errorf(stepPath(position), "STEP_UNREACHABLE",
				fmt.Sprintf("Step %q can never run: nothing leads to it from entry.", step.ID))
		}
	}
	if closing, cyclic := graph.cycle(); cyclic {
		report.errorf(stepPath(index[closing]), "STEP_GRAPH_CYCLE",
			fmt.Sprintf("Step %q is part of a cycle.", closing))
	}

	for position, step := range definition.Steps {
		if _, known := index[step.ID]; !known || index[step.ID] != position {
			continue
		}
		context := stepContext{
			path:      stepPath(position),
			ancestors: graph.ancestors(step.ID),
			index:     index,
			steps:     definition.Steps,
			options:   options,
			report:    &report,
		}
		validateStep(step, context)
	}
	return report
}

func stepPath(position int) string {
	return "/steps/" + strconv.Itoa(position)
}

func validateTrigger(trigger Trigger, options ValidateOptions, report *Report) {
	if !ValidStepID(trigger.ID) {
		report.errorf("/trigger/id", "STEP_ID_INVALID",
			"Trigger ids are lowercase letters, digits and underscores, starting with a letter.")
	}
	if !trigger.Type.Valid() {
		report.errorf("/trigger/type", "TRIGGER_TYPE_INVALID",
			fmt.Sprintf("Trigger type %q is not one of integration, schedule, manual, berry_event or webhook.", trigger.Type))
		return
	}
	switch trigger.Type {
	case TriggerIntegration:
		if trigger.Provider == "" {
			report.errorf("/trigger/provider", "STEP_FIELD_REQUIRED", "An integration trigger names its provider.")
		}
		if trigger.Operation == "" {
			report.errorf("/trigger/operation", "STEP_FIELD_REQUIRED", "An integration trigger names its operation.")
		}
		if options.Catalog != nil && trigger.Provider != "" && trigger.Operation != "" {
			spec, ok := options.Catalog.Tool(trigger.Provider, trigger.Operation, ToolTrigger)
			if !ok {
				report.errorf("/trigger/operation", "TRIGGER_UNKNOWN",
					fmt.Sprintf("No trigger %s.%s is registered.", trigger.Provider, trigger.Operation))
			} else {
				checkConnection("/trigger/provider", spec, options, report)
			}
		}
	case TriggerSchedule:
		cron, timezone := "", ""
		if trigger.Config != nil {
			cron, timezone = trigger.Config.Cron, trigger.Config.Timezone
		}
		if !ValidCronExpression(cron) {
			report.errorf("/trigger/config/cron", "SCHEDULE_CRON_INVALID",
				"A schedule needs a five-field cron expression or @hourly, @daily, @weekly, @monthly, @yearly.")
		}
		if timezone == "" {
			report.errorf("/trigger/config/timezone", "SCHEDULE_TIMEZONE_INVALID", "A schedule names its IANA timezone.")
		} else if _, err := time.LoadLocation(timezone); err != nil || timezone == "Local" {
			report.errorf("/trigger/config/timezone", "SCHEDULE_TIMEZONE_INVALID",
				fmt.Sprintf("Timezone %q is not an IANA timezone.", timezone))
		}
	case TriggerBerryEvent:
		if trigger.Event == "" {
			report.errorf("/trigger/event", "STEP_FIELD_REQUIRED", "A Berry event trigger names its event.")
		} else if !KnownBerryEvent(trigger.Event) {
			report.errorf("/trigger/event", "BERRY_EVENT_UNKNOWN",
				fmt.Sprintf("Berry does not publish %q.", trigger.Event))
		}
	}
	if trigger.Config != nil && trigger.Config.Filter != nil {
		for _, finding := range trigger.Config.Filter.Validate("/trigger/config/filter") {
			report.add(finding)
		}
		for _, ref := range trigger.Config.Filter.References() {
			if !strings.HasPrefix(ref, "trigger") {
				report.errorf("/trigger/config/filter", "OUTPUT_REF_INVALID",
					fmt.Sprintf("A trigger filter may only read the trigger payload, not %q.", ref))
			}
		}
	}
}

func checkConnection(path string, spec ToolSpec, options ValidateOptions, report *Report) {
	if !spec.ConnectionRequired || options.Catalog.Connected(spec.Provider) {
		return
	}
	message := fmt.Sprintf("Provider %q is not connected in this workspace.", spec.Provider)
	if options.RequireConnections {
		report.errorf(path, "CONNECTION_MISSING", message)
		return
	}
	report.warnf(path, "CONNECTION_MISSING", message)
}

// graph is the control-flow relation: parent → children through branches and
// through dependsOn (the dependency is the parent of the dependent).
type graph struct {
	children map[string][]string
	parents  map[string][]string
	order    []string
}

func buildGraph(definition Definition, index map[string]int, report *Report) graph {
	result := graph{
		children: map[string][]string{},
		parents:  map[string][]string{},
	}
	link := func(parent, child string) {
		result.children[parent] = append(result.children[parent], child)
		result.parents[child] = append(result.parents[child], parent)
	}
	for position, step := range definition.Steps {
		if _, known := index[step.ID]; !known || index[step.ID] != position {
			continue
		}
		result.order = append(result.order, step.ID)
		path := stepPath(position)
		for offset, dependency := range step.DependsOn {
			switch {
			case dependency == step.ID:
				report.errorf(fmt.Sprintf("%s/dependsOn/%d", path, offset), "STEP_REF_UNKNOWN",
					fmt.Sprintf("Step %q cannot depend on itself.", step.ID))
			default:
				if _, known := index[dependency]; !known {
					report.errorf(fmt.Sprintf("%s/dependsOn/%d", path, offset), "STEP_REF_UNKNOWN",
						fmt.Sprintf("Step %q does not exist.", dependency))
					continue
				}
				link(dependency, step.ID)
			}
		}
		for _, ref := range branchRefs(step) {
			if _, ok := index[ref.id]; !ok {
				report.errorf(fmt.Sprintf("%s/%s/%d", path, ref.field, ref.offset), "STEP_REF_UNKNOWN",
					fmt.Sprintf("Step %q does not exist.", ref.id))
				continue
			}
			link(step.ID, ref.id)
		}
	}
	return result
}

type branchRef struct {
	field  string
	offset int
	id     string
}

// branchRefs lists the branch targets with the field and position each came
// from, so an unknown target is reported at its own path.
func branchRefs(step Step) []branchRef {
	var refs []branchRef
	collect := func(field string, ids []string) {
		for offset, id := range ids {
			refs = append(refs, branchRef{field: field, offset: offset, id: id})
		}
	}
	switch step.Type {
	case StepCondition:
		if step.Condition != nil {
			collect("trueSteps", step.Condition.TrueSteps)
			collect("falseSteps", step.Condition.FalseSteps)
		}
	case StepSwitch:
		if step.Switch != nil {
			for index, branch := range step.Switch.Cases {
				collect(fmt.Sprintf("cases/%d/steps", index), branch.Steps)
			}
			collect("defaultSteps", step.Switch.DefaultSteps)
		}
	case StepForeach:
		if step.Foreach != nil {
			collect("steps", step.Foreach.Steps)
		}
	}
	return refs
}

func (graph graph) reachable(entry []string) map[string]bool {
	seen := map[string]bool{}
	stack := append([]string(nil), entry...)
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		stack = append(stack, graph.children[id]...)
	}
	return seen
}

// cycle returns the first step found to close a cycle.
func (graph graph) cycle() (string, bool) {
	const (
		white = 0
		grey  = 1
		black = 2
	)
	colour := map[string]int{}
	var visit func(id string) (string, bool)
	visit = func(id string) (string, bool) {
		colour[id] = grey
		for _, child := range graph.children[id] {
			switch colour[child] {
			case grey:
				return child, true
			case white:
				if closing, found := visit(child); found {
					return closing, true
				}
			}
		}
		colour[id] = black
		return "", false
	}
	for _, id := range graph.order {
		if colour[id] == white {
			if closing, found := visit(id); found {
				return closing, true
			}
		}
	}
	return "", false
}

// ancestors returns every step that runs before id on some path.
func (graph graph) ancestors(id string) map[string]bool {
	seen := map[string]bool{}
	stack := append([]string(nil), graph.parents[id]...)
	for len(stack) > 0 {
		parent := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[parent] {
			continue
		}
		seen[parent] = true
		stack = append(stack, graph.parents[parent]...)
	}
	return seen
}

type stepContext struct {
	path      string
	ancestors map[string]bool
	index     map[string]int
	steps     []Step
	options   ValidateOptions
	report    *Report
}

// checkRefs validates the references inside one value and requires every
// step reference to name an ancestor: reading the output of a step that has
// not run yet, or runs on another branch, resolves to nothing.
func (context stepContext) checkRefs(path string, refs []string, err error) {
	if err != nil {
		context.report.errorf(path, "TEMPLATE_REF_INVALID", err.Error())
		return
	}
	for _, ref := range refs {
		producer, ok := ReferencedStep(ref)
		if !ok {
			continue
		}
		if _, known := context.index[producer]; !known {
			context.report.errorf(path, "OUTPUT_REF_INVALID",
				fmt.Sprintf("Reference %q names a step that does not exist.", ref))
			continue
		}
		if !context.ancestors[producer] {
			context.report.errorf(path, "OUTPUT_REF_INVALID",
				fmt.Sprintf("Reference %q reads a step that does not run before this one.", ref))
		}
	}
}

func (context stepContext) checkValue(path string, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	refs, err := ValueReferences(raw)
	context.checkRefs(path, refs, err)
}

func (context stepContext) checkTemplate(path, text string) {
	if text == "" {
		return
	}
	refs, err := TemplateReferences(text)
	context.checkRefs(path, refs, err)
}

func (context stepContext) checkInputs(path string, input map[string]json.RawMessage) {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		context.checkValue(path+"/"+key, input[key])
	}
}

func (context stepContext) hasApprovalAncestor() bool {
	for id := range context.ancestors {
		if context.steps[context.index[id]].Type == StepApproval {
			return true
		}
	}
	return false
}

func validateStep(step Step, context stepContext) {
	path, report := context.path, context.report
	switch step.Type {
	case StepAction:
		action := step.Action
		if action.Provider == "" {
			report.errorf(path+"/provider", "STEP_FIELD_REQUIRED", "An action names its provider.")
		}
		if action.Operation == "" {
			report.errorf(path+"/operation", "STEP_FIELD_REQUIRED", "An action names its operation.")
		}
		context.checkInputs(path+"/input", action.Input)
		if context.options.Catalog == nil || action.Provider == "" || action.Operation == "" {
			return
		}
		spec, ok := context.options.Catalog.Tool(action.Provider, action.Operation, ToolAction)
		if !ok {
			report.errorf(path+"/operation", "TOOL_UNKNOWN",
				fmt.Sprintf("No action %s.%s is registered.", action.Provider, action.Operation))
			return
		}
		checkConnection(path+"/provider", spec, context.options, report)
		checkInputSchema(path+"/input", action.Input, spec.InputSchema, report)
		if (spec.Destructive || spec.RequiresApproval) && !context.hasApprovalAncestor() {
			report.add(FieldError{
				Path: path, Code: "DESTRUCTIVE_WITHOUT_APPROVAL", Severity: SeverityError,
				Message: fmt.Sprintf("%s.%s needs a human decision before it runs.", action.Provider, action.Operation),
				Hint:    "Insert an approval step before this action on the same branch.",
			})
		}
	case StepCondition:
		condition := step.Condition
		for _, finding := range condition.Expression.Validate(path + "/expression") {
			report.add(finding)
		}
		context.checkRefs(path+"/expression", condition.Expression.References(), nil)
		if len(condition.TrueSteps) == 0 && len(condition.FalseSteps) == 0 {
			report.errorf(path+"/trueSteps", "STEP_FIELD_REQUIRED", "A condition needs at least one branch.")
		}
	case StepAgent:
		agent := step.Agent
		if agent.Instruction == "" {
			report.errorf(path+"/instruction", "STEP_FIELD_REQUIRED", "An agent step needs an instruction.")
		} else if len(agent.Instruction) > MaxInstructionLength {
			report.errorf(path+"/instruction", "STEP_FIELD_INVALID",
				fmt.Sprintf("An instruction is at most %d characters.", MaxInstructionLength))
		}
		context.checkTemplate(path+"/instruction", agent.Instruction)
		if agent.IssueMode != "" && agent.IssueMode != IssueModeInline && agent.IssueMode != IssueModeIssue {
			report.errorf(path+"/issueMode", "STEP_FIELD_INVALID", "issueMode is \"inline\" or \"issue\".")
		}
		if agent.AgentID != "" && !validUUID(agent.AgentID) {
			report.errorf(path+"/agentId", "STEP_FIELD_INVALID", "agentId is a UUID.")
		}
		for offset, capability := range agent.RequiredCapabilities {
			if !capabilityPattern.MatchString(capability) {
				report.errorf(fmt.Sprintf("%s/requiredCapabilities/%d", path, offset), "STEP_FIELD_INVALID",
					"Capabilities are lowercase letters, digits and dashes.")
			}
		}
		if len(agent.OutputSchema) > 0 {
			var schema map[string]any
			if json.Unmarshal(agent.OutputSchema, &schema) != nil || schema == nil {
				report.errorf(path+"/outputSchema", "STEP_FIELD_INVALID", "outputSchema is a JSON Schema object.")
			}
		}
		context.checkInputs(path+"/input", agent.Input)
	case StepCreateIssue:
		create := step.CreateIssue
		if create.Title == "" {
			report.errorf(path+"/title", "STEP_FIELD_REQUIRED", "A created issue needs a title.")
		}
		context.checkTemplate(path+"/title", create.Title)
		context.checkTemplate(path+"/description", create.Description)
		if create.AssignAgentID != "" && !validUUID(create.AssignAgentID) {
			report.errorf(path+"/assignAgentId", "STEP_FIELD_INVALID", "assignAgentId is a UUID.")
		}
		if create.BoardID != "" && !validUUID(create.BoardID) {
			report.errorf(path+"/boardId", "STEP_FIELD_INVALID", "boardId is a UUID.")
		}
		if create.GoalID != "" && !validUUID(create.GoalID) {
			refs, err := TemplateReferences(create.GoalID)
			if err != nil || len(refs) != 1 || refs[0] != "goal.id" {
				report.errorf(path+"/goalId", "STEP_FIELD_INVALID", "goalId is a UUID or {{ goal.id }}.")
			}
		}
		if create.Priority != "" && !issuePriorities[create.Priority] {
			report.errorf(path+"/priority", "STEP_FIELD_INVALID", "priority is none, low, medium, high or urgent.")
		}
	case StepUpdateIssue:
		update := step.UpdateIssue
		if len(update.Issue) == 0 {
			report.errorf(path+"/issue", "STEP_FIELD_REQUIRED", "update_issue names the issue to change.")
		} else {
			context.checkValue(path+"/issue", update.Issue)
		}
		if update.Patch.Empty() {
			report.errorf(path+"/patch", "STEP_FIELD_REQUIRED", "The patch changes at least one field.")
		}
		if update.Patch.Status != nil && !issueStatuses[*update.Patch.Status] {
			report.errorf(path+"/patch/status", "STEP_FIELD_INVALID", "status is not an issue status.")
		}
		if update.Patch.Priority != nil && !issuePriorities[*update.Patch.Priority] {
			report.errorf(path+"/patch/priority", "STEP_FIELD_INVALID", "priority is none, low, medium, high or urgent.")
		}
		if update.Patch.AssignAgentID != nil && !validUUID(*update.Patch.AssignAgentID) {
			report.errorf(path+"/patch/assignAgentId", "STEP_FIELD_INVALID", "assignAgentId is a UUID.")
		}
		for field, value := range map[string]*string{"title": update.Patch.Title, "description": update.Patch.Description} {
			if value != nil {
				context.checkTemplate(path+"/patch/"+field, *value)
			}
		}
	case StepApproval:
		approval := step.Approval
		if approval.Title == "" {
			report.errorf(path+"/title", "STEP_FIELD_REQUIRED", "An approval needs a title.")
		}
		switch approval.Approver.Type {
		case ApproverUser:
			if !validUUID(approval.Approver.UserID) {
				report.errorf(path+"/approver/userId", "APPROVAL_APPROVER_REQUIRED", "A user approver names a user id.")
			}
		case ApproverRole:
			if !workspaceRoles[approval.Approver.Role] {
				report.errorf(path+"/approver/role", "APPROVAL_APPROVER_REQUIRED", "A role approver is owner, admin or member.")
			}
		default:
			report.errorf(path+"/approver/type", "APPROVAL_APPROVER_REQUIRED", "An approval is addressed to a user or a role.")
		}
		if approval.Timeout != "" && !ValidDuration(approval.Timeout) {
			report.errorf(path+"/timeout", "STEP_FIELD_INVALID", "timeout is an ISO-8601 duration such as P7D or PT4H.")
		}
	case StepWait:
		wait := step.Wait
		switch wait.Mode {
		case WaitModeDuration:
			if !ValidDuration(wait.Duration) {
				report.errorf(path+"/duration", "WAIT_MODE_INCOMPLETE", "A duration wait needs an ISO-8601 duration such as PT30M.")
			}
		case WaitModeUntil:
			if wait.Until == "" {
				report.errorf(path+"/until", "WAIT_MODE_INCOMPLETE", "An until wait needs an RFC 3339 instant or a template.")
			} else if refs, err := TemplateReferences(wait.Until); err != nil {
				report.errorf(path+"/until", "TEMPLATE_REF_INVALID", err.Error())
			} else if len(refs) == 0 {
				if _, err := time.Parse(time.RFC3339, wait.Until); err != nil {
					report.errorf(path+"/until", "WAIT_MODE_INCOMPLETE", "until is an RFC 3339 instant.")
				}
			} else {
				context.checkRefs(path+"/until", refs, nil)
			}
		case WaitModeEvent:
			if wait.Event == nil || wait.Event.Provider == "" || wait.Event.Event == "" {
				report.errorf(path+"/event", "WAIT_MODE_INCOMPLETE", "An event wait names a provider and an event.")
			} else {
				if wait.Event.Provider == "berry" && !KnownBerryEvent(wait.Event.Event) {
					report.errorf(path+"/event/event", "BERRY_EVENT_UNKNOWN",
						fmt.Sprintf("Berry does not publish %q.", wait.Event.Event))
				}
				if wait.Event.Filter != nil {
					for _, finding := range wait.Event.Filter.Validate(path + "/event/filter") {
						report.add(finding)
					}
					context.checkRefs(path+"/event/filter", wait.Event.Filter.References(), nil)
				}
			}
		default:
			report.errorf(path+"/mode", "WAIT_MODE_INCOMPLETE", "A wait is for a duration, until an instant, or for an event.")
		}
	case StepSwitch:
		if step.Switch != nil {
			context.checkValue(path+"/value", step.Switch.Value)
			if len(step.Switch.Cases) == 0 {
				report.errorf(path+"/cases", "SWITCH_CASES_EMPTY", "A switch needs at least one case.")
			}
		}
	case StepForeach:
		if step.Foreach != nil {
			if _, ok := ParseReference(step.Foreach.Items); !ok {
				report.errorf(path+"/items", "FOREACH_NOT_ITERABLE", "foreach iterates a reference to an array.")
			} else {
				context.checkValue(path+"/items", step.Foreach.Items)
			}
		}
	case StepTransform:
		if step.Transform != nil {
			context.checkInputs(path+"/output", step.Transform.Output)
		}
	case StepSubworkflow:
		if step.Subworkflow != nil {
			context.checkInputs(path+"/input", step.Subworkflow.Input)
		}
	}
}

// checkInputSchema applies the part of a tool's JSON Schema a validator can
// settle without values: required properties are present, and no property
// outside the schema is supplied when the schema closes the object.
func checkInputSchema(path string, input map[string]json.RawMessage, schema map[string]any, report *Report) {
	if schema == nil {
		return
	}
	if required, ok := schema["required"].([]any); ok {
		for _, entry := range required {
			name, ok := entry.(string)
			if !ok {
				continue
			}
			if _, present := input[name]; !present {
				report.errorf(path+"/"+name, "INPUT_REQUIRED_MISSING", fmt.Sprintf("Input %q is required.", name))
			}
		}
	}
	properties, hasProperties := schema["properties"].(map[string]any)
	additional, declared := schema["additionalProperties"].(bool)
	if !hasProperties || !declared || additional {
		return
	}
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if _, known := properties[key]; !known {
			report.errorf(path+"/"+key, "INPUT_UNKNOWN_PROPERTY", fmt.Sprintf("Input %q is not accepted by this tool.", key))
		}
	}
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil && parsed.String() == value
}
