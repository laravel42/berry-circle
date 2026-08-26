// Package ir is the BerryPlan v1 intermediate representation: the only shape
// the planner may emit and the only input the compiler reads. It is data plus
// a structural check; the semantic validator (integrations, agents, policy)
// arrives with the planner pipeline and builds on it.
package ir

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
)

// Schema and Version identify the shape.
const (
	Schema  = "berry-plan/1"
	Version = "1"
)

// Bounds the planner and the validator agree on.
const (
	MaxIssues    = 50
	MaxWorkflows = 20
)

var (
	goalTempIDPattern     = regexp.MustCompile(`^g_[a-z0-9_]{1,40}$`)
	issueTempIDPattern    = regexp.MustCompile(`^i_[a-z0-9_]{1,40}$`)
	workflowTempIDPattern = regexp.MustCompile(`^w_[a-z0-9_]{1,40}$`)
	approvalTempIDPattern = regexp.MustCompile(`^p_[a-z0-9_]{1,40}$`)
	assumptionIDPattern   = regexp.MustCompile(`^a_[a-z0-9_]{1,40}$`)
	capabilityPattern     = regexp.MustCompile(`^[a-z0-9-]{1,50}$`)
	providerPattern       = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)
)

// Plan is BerryPlan v1.
type Plan struct {
	Schema              string               `json:"$schema"`
	Version             string               `json:"version"`
	Goal                Goal                 `json:"goal"`
	Assumptions         []Assumption         `json:"assumptions,omitempty"`
	RequiredConnections []RequiredConnection `json:"requiredConnections,omitempty"`
	Issues              []Issue              `json:"issues,omitempty"`
	Workflows           []Workflow           `json:"workflows,omitempty"`
	Approvals           []Approval           `json:"approvals,omitempty"`
	Dependencies        []Dependency         `json:"dependencies,omitempty"`
	Confidence          float64              `json:"confidence"`
	// Compiled is written by the compiler beside the plan so a reader can map
	// temporary ids to the rows they became. The planner never sets it.
	Compiled *Compiled `json:"compiled,omitempty"`
}

// Goal is the outcome the plan serves.
type Goal struct {
	TempID      string     `json:"tempId"`
	Title       string     `json:"title"`
	Description *string    `json:"description,omitempty"`
	ProjectID   *uuid.UUID `json:"projectId,omitempty"`
}

// Assumption is something the planner decided without being told.
type Assumption struct {
	ID           string `json:"id"`
	Description  string `json:"description"`
	Confidence   string `json:"confidence"`
	UserEditable bool   `json:"userEditable"`
	Blocking     bool   `json:"blocking,omitempty"`
}

// RequiredConnection names a provider the plan needs connected.
type RequiredConnection struct {
	Provider  string `json:"provider"`
	Purpose   string `json:"purpose"`
	Connected bool   `json:"connected"`
}

// Issue is one finite piece of work that becomes a board issue.
type Issue struct {
	TempID               string     `json:"tempId"`
	Title                string     `json:"title"`
	Description          *string    `json:"description,omitempty"`
	Type                 string     `json:"type"`
	SuggestedAgentID     *uuid.UUID `json:"suggestedAgentId,omitempty"`
	RequiredCapabilities []string   `json:"requiredCapabilities,omitempty"`
	Priority             string     `json:"priority,omitempty"`
	DependsOn            []string   `json:"dependsOn,omitempty"`
	RequiresReview       bool       `json:"requiresReview,omitempty"`
	RequiresApproval     bool       `json:"requiresApproval,omitempty"`
	ExpectedArtifacts    []string   `json:"expectedArtifacts,omitempty"`
	Estimate             *string    `json:"estimate,omitempty"`
}

// Workflow is one repeatable process that becomes a workflow draft. Its
// trigger, steps and entry are exactly a WorkflowDefinition v1.
type Workflow struct {
	TempID            string             `json:"tempId"`
	Name              string             `json:"name"`
	Description       *string            `json:"description,omitempty"`
	Trigger           automation.Trigger `json:"trigger"`
	Steps             []automation.Step  `json:"steps"`
	Entry             []string           `json:"entry"`
	ActivateOnApprove bool               `json:"activateOnApprove,omitempty"`
}

// Definition is the workflow as the automation package stores it.
func (workflow Workflow) Definition() automation.Definition {
	return automation.Definition{
		Version: automation.DefinitionVersion,
		Trigger: workflow.Trigger,
		Steps:   append([]automation.Step(nil), workflow.Steps...),
		Entry:   append([]string(nil), workflow.Entry...),
	}
}

// ApprovalTarget names what an approval gates.
type ApprovalTarget struct {
	Kind   string `json:"kind"`
	TempID string `json:"tempId"`
	StepID string `json:"stepId,omitempty"`
}

// Approval is a human decision the plan asks for.
type Approval struct {
	TempID      string              `json:"tempId"`
	Title       string              `json:"title"`
	Description *string             `json:"description,omitempty"`
	Reason      string              `json:"reason"`
	Target      ApprovalTarget      `json:"target"`
	Approver    automation.Approver `json:"approver"`
	Timeout     string              `json:"timeout,omitempty"`
}

// Dependency is an ordering between two plan items.
type Dependency struct {
	From string `json:"from"`
	To   string `json:"to"`
	Kind string `json:"kind"`
}

// Compiled maps temporary ids to the rows the compiler created.
type Compiled struct {
	GoalID      uuid.UUID            `json:"goalId"`
	IssueIDs    map[string]uuid.UUID `json:"issueIds"`
	WorkflowIDs map[string]uuid.UUID `json:"workflowIds"`
	ApprovalIDs map[string]uuid.UUID `json:"approvalIds"`
	CompiledAt  string               `json:"compiledAt"`
}

// Parse decodes a stored or generated plan strictly. Unknown fields are an
// error: the planner is held to the schema, not tolerated around it.
func Parse(raw []byte) (Plan, error) {
	var plan Plan
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&plan); err != nil {
		return Plan{}, fmt.Errorf("plan is not valid BerryPlan JSON: %w", err)
	}
	if decoder.More() {
		return Plan{}, errors.New("plan has trailing data")
	}
	return plan, nil
}

// Finding is one structural problem, at a JSON pointer inside the plan.
type Finding = automation.FieldError

func finding(path, code, message string) Finding {
	return Finding{Path: path, Code: code, Message: message, Severity: automation.SeverityError}
}

// CheckStructure runs the structural rules: version, ids, references and the
// issue dependency graph. It is deterministic and needs no catalog, which is
// why the compiler can re-run it on the stored IR before writing anything.
// Workflow definitions are checked separately with automation.ValidateDefinition.
func CheckStructure(plan Plan) []Finding {
	var findings []Finding
	if plan.Schema != Schema || plan.Version != Version {
		findings = append(findings, finding("/version", "PLAN_VERSION_UNSUPPORTED",
			fmt.Sprintf("Plan schema %q version %q is not supported.", plan.Schema, plan.Version)))
	}
	if !goalTempIDPattern.MatchString(plan.Goal.TempID) {
		findings = append(findings, finding("/goal/tempId", "TEMP_ID_INVALID", "Goal ids look like g_name."))
	}
	if len(plan.Goal.Title) < 1 || len(plan.Goal.Title) > 500 {
		findings = append(findings, finding("/goal/title", "GOAL_REQUIRED", "A plan names its goal in 1 to 500 characters."))
	}
	if len(plan.Issues) > MaxIssues {
		findings = append(findings, finding("/issues", "PLAN_TOO_LARGE", fmt.Sprintf("A plan may have at most %d issues.", MaxIssues)))
	}
	if len(plan.Workflows) > MaxWorkflows {
		findings = append(findings, finding("/workflows", "PLAN_TOO_LARGE", fmt.Sprintf("A plan may have at most %d workflows.", MaxWorkflows)))
	}
	if len(plan.Issues) == 0 && len(plan.Workflows) == 0 {
		findings = append(findings, Finding{Path: "/issues", Code: "PLAN_EMPTY", Severity: automation.SeverityWarning,
			Message: "The plan proposes no issues and no workflows."})
	}
	seen := map[string]string{plan.Goal.TempID: "/goal/tempId"}
	claim := func(path, id string) {
		if previous, exists := seen[id]; exists {
			findings = append(findings, finding(path, "TEMP_ID_DUPLICATE", fmt.Sprintf("Id %q is already used at %s.", id, previous)))
			return
		}
		seen[id] = path
	}
	issues := map[string]int{}
	for index, issue := range plan.Issues {
		path := "/issues/" + strconv.Itoa(index)
		if !issueTempIDPattern.MatchString(issue.TempID) {
			findings = append(findings, finding(path+"/tempId", "TEMP_ID_INVALID", "Issue ids look like i_name."))
		} else {
			claim(path+"/tempId", issue.TempID)
			issues[issue.TempID] = index
		}
		if len(issue.Title) < 1 || len(issue.Title) > 500 {
			findings = append(findings, finding(path+"/title", "STEP_FIELD_REQUIRED", "An issue needs a title of 1 to 500 characters."))
		}
		if issue.Type != "" && issue.Type != "issue" {
			findings = append(findings, finding(path+"/type", "STEP_FIELD_INVALID", "Issue type is \"issue\"."))
		}
		switch issue.Priority {
		case "", "low", "medium", "high", "urgent":
		default:
			findings = append(findings, finding(path+"/priority", "STEP_FIELD_INVALID", "priority is low, medium, high or urgent."))
		}
		for offset, capability := range issue.RequiredCapabilities {
			if !capabilityPattern.MatchString(capability) {
				findings = append(findings, finding(fmt.Sprintf("%s/requiredCapabilities/%d", path, offset), "STEP_FIELD_INVALID",
					"Capabilities are lowercase letters, digits and dashes."))
			}
		}
	}
	for index, issue := range plan.Issues {
		path := "/issues/" + strconv.Itoa(index)
		for offset, dependency := range issue.DependsOn {
			switch {
			case dependency == issue.TempID:
				findings = append(findings, finding(fmt.Sprintf("%s/dependsOn/%d", path, offset), "DEP_SELF", "An issue cannot depend on itself."))
			default:
				if _, ok := issues[dependency]; !ok {
					findings = append(findings, finding(fmt.Sprintf("%s/dependsOn/%d", path, offset), "DEP_UNKNOWN_REF",
						fmt.Sprintf("Issue %q does not exist.", dependency)))
				}
			}
		}
	}
	workflows := map[string]int{}
	for index, workflow := range plan.Workflows {
		path := "/workflows/" + strconv.Itoa(index)
		if !workflowTempIDPattern.MatchString(workflow.TempID) {
			findings = append(findings, finding(path+"/tempId", "TEMP_ID_INVALID", "Workflow ids look like w_name."))
		} else {
			claim(path+"/tempId", workflow.TempID)
			workflows[workflow.TempID] = index
		}
		if len(workflow.Name) < 1 || len(workflow.Name) > 200 {
			findings = append(findings, finding(path+"/name", "STEP_FIELD_REQUIRED", "A workflow needs a name of 1 to 200 characters."))
		}
	}
	for index, approval := range plan.Approvals {
		path := "/approvals/" + strconv.Itoa(index)
		if !approvalTempIDPattern.MatchString(approval.TempID) {
			findings = append(findings, finding(path+"/tempId", "TEMP_ID_INVALID", "Approval ids look like p_name."))
		} else {
			claim(path+"/tempId", approval.TempID)
		}
		if approval.Title == "" {
			findings = append(findings, finding(path+"/title", "STEP_FIELD_REQUIRED", "An approval needs a title."))
		}
		switch approval.Reason {
		case "policy", "user_requested", "planner":
		default:
			findings = append(findings, finding(path+"/reason", "STEP_FIELD_INVALID", "reason is policy, user_requested or planner."))
		}
		switch approval.Target.Kind {
		case "issue":
			if _, ok := issues[approval.Target.TempID]; !ok {
				findings = append(findings, finding(path+"/target/tempId", "DEP_UNKNOWN_REF", fmt.Sprintf("Issue %q does not exist.", approval.Target.TempID)))
			}
		case "workflow":
			if _, ok := workflows[approval.Target.TempID]; !ok {
				findings = append(findings, finding(path+"/target/tempId", "DEP_UNKNOWN_REF", fmt.Sprintf("Workflow %q does not exist.", approval.Target.TempID)))
			}
		case "step":
			index, ok := workflows[approval.Target.TempID]
			if !ok {
				findings = append(findings, finding(path+"/target/tempId", "DEP_UNKNOWN_REF", fmt.Sprintf("Workflow %q does not exist.", approval.Target.TempID)))
			} else if !hasStep(plan.Workflows[index], approval.Target.StepID) {
				findings = append(findings, finding(path+"/target/stepId", "STEP_REF_UNKNOWN", fmt.Sprintf("Step %q does not exist.", approval.Target.StepID)))
			}
		default:
			findings = append(findings, finding(path+"/target/kind", "STEP_FIELD_INVALID", "target.kind is issue, workflow or step."))
		}
		switch approval.Approver.Type {
		case automation.ApproverUser:
			if _, err := uuid.Parse(approval.Approver.UserID); err != nil {
				findings = append(findings, finding(path+"/approver/userId", "APPROVAL_APPROVER_REQUIRED", "A user approver names a user id."))
			}
		case automation.ApproverRole:
			switch approval.Approver.Role {
			case "owner", "admin", "member":
			default:
				findings = append(findings, finding(path+"/approver/role", "APPROVAL_APPROVER_REQUIRED", "A role approver is owner, admin or member."))
			}
		default:
			findings = append(findings, finding(path+"/approver/type", "APPROVAL_APPROVER_REQUIRED", "An approval is addressed to a user or a role."))
		}
		if approval.Timeout != "" && !automation.ValidDuration(approval.Timeout) {
			findings = append(findings, finding(path+"/timeout", "STEP_FIELD_INVALID", "timeout is an ISO-8601 duration such as P7D."))
		}
	}
	for index, dependency := range plan.Dependencies {
		path := "/dependencies/" + strconv.Itoa(index)
		if dependency.Kind != "blocks" && dependency.Kind != "informs" {
			findings = append(findings, finding(path+"/kind", "STEP_FIELD_INVALID", "kind is blocks or informs."))
		}
		if _, ok := seen[dependency.From]; !ok {
			findings = append(findings, finding(path+"/from", "DEP_UNKNOWN_REF", fmt.Sprintf("Item %q does not exist.", dependency.From)))
		}
		if _, ok := seen[dependency.To]; !ok {
			findings = append(findings, finding(path+"/to", "DEP_UNKNOWN_REF", fmt.Sprintf("Item %q does not exist.", dependency.To)))
		}
		if dependency.From == dependency.To {
			findings = append(findings, finding(path, "DEP_SELF", "An item cannot depend on itself."))
		}
	}
	for index, assumption := range plan.Assumptions {
		path := "/assumptions/" + strconv.Itoa(index)
		if !assumptionIDPattern.MatchString(assumption.ID) {
			findings = append(findings, finding(path+"/id", "TEMP_ID_INVALID", "Assumption ids look like a_name."))
		}
		switch assumption.Confidence {
		case "low", "medium", "high":
		default:
			findings = append(findings, finding(path+"/confidence", "STEP_FIELD_INVALID", "confidence is low, medium or high."))
		}
	}
	for index, connection := range plan.RequiredConnections {
		if !providerPattern.MatchString(connection.Provider) {
			findings = append(findings, finding("/requiredConnections/"+strconv.Itoa(index)+"/provider", "STEP_FIELD_INVALID",
				"provider is a lowercase identifier."))
		}
	}
	if plan.Confidence < 0 || plan.Confidence > 1 {
		findings = append(findings, finding("/confidence", "STEP_FIELD_INVALID", "confidence is between 0 and 1."))
	}
	if closing, cyclic := issueCycle(plan.Issues, issues); cyclic {
		findings = append(findings, finding("/issues/"+strconv.Itoa(issues[closing])+"/dependsOn", "DEP_CYCLE",
			fmt.Sprintf("Issue %q is part of a dependency cycle.", closing)))
	}
	return findings
}

// Valid reports whether findings contain no error.
func Valid(findings []Finding) bool {
	for _, item := range findings {
		if item.Severity != automation.SeverityWarning {
			return false
		}
	}
	return true
}

func hasStep(workflow Workflow, stepID string) bool {
	for _, step := range workflow.Steps {
		if step.ID == stepID {
			return true
		}
	}
	return false
}

// TopologicalIssues orders issues so every blocker precedes its dependents,
// keeping the plan's own order among independent issues. ok is false when
// the graph has a cycle, which CheckStructure reports separately.
func TopologicalIssues(issues []Issue) ([]Issue, bool) {
	index := make(map[string]int, len(issues))
	for position, issue := range issues {
		index[issue.TempID] = position
	}
	const (
		white = 0
		grey  = 1
		black = 2
	)
	colour := make([]int, len(issues))
	ordered := make([]Issue, 0, len(issues))
	var visit func(position int) bool
	visit = func(position int) bool {
		switch colour[position] {
		case grey:
			return false
		case black:
			return true
		}
		colour[position] = grey
		for _, dependency := range issues[position].DependsOn {
			blocker, ok := index[dependency]
			if !ok {
				continue
			}
			if !visit(blocker) {
				return false
			}
		}
		colour[position] = black
		ordered = append(ordered, issues[position])
		return true
	}
	for position := range issues {
		if !visit(position) {
			return nil, false
		}
	}
	return ordered, true
}

func issueCycle(issues []Issue, index map[string]int) (string, bool) {
	if _, ok := TopologicalIssues(issues); ok {
		return "", false
	}
	// Name the first issue whose dependency chain closes on itself.
	for _, issue := range issues {
		if reaches(issues, index, issue.TempID, issue.TempID, map[string]bool{}) {
			return issue.TempID, true
		}
	}
	return issues[0].TempID, true
}

func reaches(issues []Issue, index map[string]int, from, target string, seen map[string]bool) bool {
	position, ok := index[from]
	if !ok {
		return false
	}
	for _, dependency := range issues[position].DependsOn {
		if dependency == target {
			return true
		}
		if seen[dependency] {
			continue
		}
		seen[dependency] = true
		if reaches(issues, index, dependency, target, seen) {
			return true
		}
	}
	return false
}
