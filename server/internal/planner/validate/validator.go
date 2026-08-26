// Package validate is the deterministic check every generated plan passes
// before a person sees it and before anything compiles: the structural rules
// of the IR, the workflow rules of the automation package with the
// workspace's tool catalog, and the semantic rules that need the workspace —
// which agents exist and what they can do, what is already there, who may
// approve, what must be approved, and what may never leave the plan. It runs
// the same way in the pipeline, in the plan routes and in tests, so a plan
// reads the same everywhere.
package validate

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
)

// Agent is what the validator knows about one workspace agent.
type Agent struct {
	ID   uuid.UUID
	Name string
	// Skills are Berry-authored capability names; Tools the runtime's tool
	// names. Either satisfies a required capability.
	Skills []string
	Tools  []string
	// Status is the registry status: available, busy, offline, unknown.
	Status     string
	ActiveRuns int
	// Limits are the manifest snapshot when the runtime reports one.
	MaxTokens           *int64
	MaxLLMTokensPerHour *int64
	CostTier            string
	// Orchestrator marks the protected built-in agent, which a plan must
	// never route work to.
	Orchestrator bool
}

// ExistingIssue is an open issue in the workspace the plan may duplicate.
type ExistingIssue struct {
	ID         uuid.UUID
	Identifier string
	Title      string
	Status     string
}

// ExistingWorkflow is a live automation the plan may duplicate.
type ExistingWorkflow struct {
	ID               uuid.UUID
	Name             string
	Status           string
	TriggerType      string
	TriggerProvider  string
	TriggerOperation string
	TriggerEvent     string
	// Actions lists provider.operation of every action step.
	Actions []string
}

// Workspace is the scope every id in the plan must resolve inside. A nil
// set means unknown, which skips the corresponding rule.
type Workspace struct {
	ID       uuid.UUID
	Boards   map[uuid.UUID]bool
	Projects map[uuid.UUID]bool
	Members  map[uuid.UUID]bool
	// HasProject and HasRepository describe the project the plan targets.
	HasProject    bool
	HasRepository bool
}

// Permissions is what the requesting person may do.
type Permissions struct {
	// Role is the workspace role name, "" when unknown.
	Role string
	// CanWrite is product.write; a person without it cannot plan.
	CanWrite bool
	// CanActivateHighRisk is settings.write.
	CanActivateHighRisk bool
	// Known is false when nothing about the actor is known, which skips
	// the permission rules rather than refusing.
	Known bool
}

// Input is everything one validation reads.
type Input struct {
	Plan ir.Plan
	// Previous is the last version, for rules that compare versions.
	Previous *ir.Plan
	// Catalog is the workspace's tool view; nil skips integration rules.
	Catalog           automation.Catalog
	Workspace         Workspace
	Agents            []Agent
	ExistingIssues    []ExistingIssue
	ExistingWorkflows []ExistingWorkflow
	Permissions       Permissions
	// AllUnknown means every requirement of the intent was unclassifiable,
	// in which case an empty plan is the honest answer, not a warning.
	AllUnknown bool
}

// RequiredConnection is a provider the plan needs with its live status.
type RequiredConnection struct {
	Provider  string `json:"provider"`
	Purpose   string `json:"purpose"`
	Connected bool   `json:"connected"`
}

// Report is the outcome of one validation.
type Report struct {
	Errors              []ir.Finding
	Warnings            []ir.Finding
	RequiredConnections []RequiredConnection
	Risk                automation.Risk
	// NeedsAdminActivation is true when the plan is high risk and the
	// requesting person may not activate high-risk work.
	NeedsAdminActivation bool
}

// Valid reports whether the plan may be approved.
func (report Report) Valid() bool {
	return len(report.Errors) == 0
}

// Findings returns errors then warnings.
func (report Report) Findings() []ir.Finding {
	out := make([]ir.Finding, 0, len(report.Errors)+len(report.Warnings))
	out = append(out, report.Errors...)
	return append(out, report.Warnings...)
}

// Blocked reports whether the only errors are unanswered blocking questions.
func (report Report) Blocked() bool {
	if len(report.Errors) == 0 {
		return false
	}
	for _, item := range report.Errors {
		if item.Code != CodeAmbiguityBlocking {
			return false
		}
	}
	return true
}

// JSON encodes the report the way plan_versions.validation stores it.
func (report Report) JSON() json.RawMessage {
	errors := report.Errors
	if errors == nil {
		errors = []ir.Finding{}
	}
	warnings := report.Warnings
	if warnings == nil {
		warnings = []ir.Finding{}
	}
	connections := report.RequiredConnections
	if connections == nil {
		connections = []RequiredConnection{}
	}
	encoded, err := json.Marshal(map[string]any{
		"errors": errors, "warnings": warnings, "requiredConnections": connections,
		"risk": report.Risk, "needsAdminActivation": report.NeedsAdminActivation,
	})
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func (report *Report) add(finding ir.Finding) {
	if finding.Severity == automation.SeverityWarning {
		report.Warnings = append(report.Warnings, finding)
		return
	}
	finding.Severity = automation.SeverityError
	report.Errors = append(report.Errors, finding)
}

func (report *Report) errorf(path, code, message string) {
	report.add(ir.Finding{Path: path, Code: code, Message: message, Severity: automation.SeverityError})
}

func (report *Report) warnf(path, code, message string) {
	report.add(ir.Finding{Path: path, Code: code, Message: message, Severity: automation.SeverityWarning})
}

func (report *Report) hint(path, code, message, hint string, severity automation.Severity) {
	report.add(ir.Finding{Path: path, Code: code, Message: message, Hint: hint, Severity: severity})
}

// Validate runs every rule. It is deterministic for a given input.
func Validate(input Input) Report {
	var report Report
	plan := input.Plan

	// Structural rules, with PLAN_EMPTY dropped when nothing was classifiable.
	for _, finding := range ir.CheckStructure(plan) {
		if finding.Code == "PLAN_EMPTY" && input.AllUnknown {
			continue
		}
		report.add(finding)
	}
	for index, workflow := range plan.Workflows {
		prefix := "/workflows/" + strconv.Itoa(index)
		definition := workflow.Definition()
		result := automation.ValidateDefinition(definition, automation.ValidateOptions{Catalog: input.Catalog})
		for _, finding := range append(append([]automation.FieldError(nil), result.Errors...), result.Warnings...) {
			finding.Path = prefix + finding.Path
			if finding.Code == "CONNECTION_MISSING" {
				finding = connectionFinding(plan, workflow, finding, prefix)
			}
			report.add(finding)
		}
	}
	report.RequiredConnections = requiredConnections(plan, input.Catalog)

	checkAmbiguities(plan, &report)
	checkAgents(input, &report)
	checkSafety(input, &report)
	checkScope(input, &report)
	checkDuplicates(input, &report)

	report.Risk = Risk(plan, input.Catalog)
	if input.Permissions.Known {
		if !input.Permissions.CanWrite {
			report.errorf("", CodePlanForbidden, "Viewers cannot plan; a member or admin must request the plan.")
		}
		if report.Risk == automation.RiskHigh && !input.Permissions.CanActivateHighRisk {
			report.NeedsAdminActivation = true
			report.warnf("", CodeNeedsAdminActivation, "The plan carries high-risk work; an admin must approve it or activate its workflows.")
		}
	}
	return report
}

// Risk is the plan's risk class: the highest of its workflows' derived risk
// and its issues' policy matches.
func Risk(plan ir.Plan, catalog automation.Catalog) automation.Risk {
	risk := automation.RiskLow
	raise := func(level automation.Risk) {
		if riskRank(level) > riskRank(risk) {
			risk = level
		}
	}
	for _, workflow := range plan.Workflows {
		raise(automation.DeriveMetadata(workflow.Definition(), catalog).Risk)
	}
	for _, issue := range plan.Issues {
		if policy, ok := integrationcore.MatchPolicy(issueText(issue)); ok {
			raise(automation.Risk(policy.Risk))
		} else if issue.RequiresApproval {
			raise(automation.RiskMedium)
		}
	}
	return risk
}

func riskRank(level automation.Risk) int {
	switch level {
	case automation.RiskHigh:
		return 2
	case automation.RiskMedium:
		return 1
	}
	return 0
}

func issueText(issue ir.Issue) string {
	text := issue.Title
	if issue.Description != nil {
		text += "\n" + *issue.Description
	}
	return text
}

// connectionFinding applies the plan-level rule to a workflow's missing
// connection: declared under requiredConnections it stays a warning (the
// plan compiles, activation waits for the connection); undeclared it is an
// error, because the person would only learn about it at activation.
func connectionFinding(plan ir.Plan, workflow ir.Workflow, finding automation.FieldError, prefix string) automation.FieldError {
	provider := providerAt(workflow, strings.TrimPrefix(finding.Path, prefix))
	if provider == "" {
		return finding
	}
	for _, declared := range plan.RequiredConnections {
		if declared.Provider == provider {
			finding.Severity = automation.SeverityWarning
			return finding
		}
	}
	finding.Severity = automation.SeverityError
	finding.Hint = fmt.Sprintf("Add %q to requiredConnections with its purpose so the plan can be approved while the connection is pending.", provider)
	return finding
}

// providerAt resolves the provider named at a definition path such as
// /trigger/provider or /steps/2/provider.
func providerAt(workflow ir.Workflow, path string) string {
	if path == "/trigger/provider" {
		return workflow.Trigger.Provider
	}
	rest, ok := strings.CutPrefix(path, "/steps/")
	if !ok {
		return ""
	}
	index, _, _ := strings.Cut(rest, "/")
	position, err := strconv.Atoi(index)
	if err != nil || position < 0 || position >= len(workflow.Steps) {
		return ""
	}
	step := workflow.Steps[position]
	if step.Action != nil {
		return step.Action.Provider
	}
	return ""
}

func requiredConnections(plan ir.Plan, catalog automation.Catalog) []RequiredConnection {
	out := make([]RequiredConnection, 0, len(plan.RequiredConnections))
	for _, connection := range plan.RequiredConnections {
		out = append(out, RequiredConnection{
			Provider: connection.Provider, Purpose: connection.Purpose,
			Connected: catalog != nil && catalog.Connected(connection.Provider),
		})
	}
	return out
}

// checkAmbiguities refuses a plan that still carries blocking questions.
func checkAmbiguities(plan ir.Plan, report *Report) {
	for index, assumption := range plan.Assumptions {
		if assumption.Blocking {
			report.hint("/assumptions/"+strconv.Itoa(index), CodeAmbiguityBlocking,
				"The plan is waiting on an answer: "+assumption.Description,
				"Answer the question to resume planning.", automation.SeverityError)
		}
	}
}
