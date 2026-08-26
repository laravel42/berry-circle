package planner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/laravel42/berry-circle/server/internal/modelgateway"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Generation error codes a reader sees in generation.error.
const (
	ErrorPlanInvalid        = "PLAN_INVALID"
	ErrorRoleRateLimited    = "ROLE_RATE_LIMITED"
	ErrorPlannerUnavailable = "PLANNER_UNAVAILABLE"
	ErrorRequestTooLarge    = "REQUEST_TOO_LARGE"
	ErrorShutdown           = "shutdown"
	ErrorTimeout            = "timeout"
	ErrorUpstream           = "upstream error"
	ErrorStore              = "store error"
)

// Bounds of one pipeline.
const (
	maxCallTimeout    = 90 * time.Second
	bookkeepingWindow = 15 * time.Second
	confidencePenalty = 0.1
	confidenceFloor   = 0.05
)

// Topics the pipeline emits on the workspace stream.
const (
	TopicPlanUpdated   = "plan.updated"
	TopicPlanGenerated = "plan.generated"
	TopicPlanBlocked   = "plan.blocked"
)

// run is one generation in flight.
type run struct {
	service     *Service
	header      plans.PlanHeader
	input       GenerateInput
	permissions validate.Permissions
	version     int
	repairs     int
	finished    bool
	// project is the linked project, read once before intent so the classifier
	// can see the brief it would otherwise ask the person to locate.
	project *ProjectData
}

func (r *run) now() time.Time { return r.service.options.Clock().UTC() }

// bookkeeping returns a context for the writes that must land even after
// the pipeline's own deadline or a shutdown cancelled it.
func (r *run) bookkeeping(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), bookkeepingWindow)
}

// execute runs the stages in order and always leaves the header in a
// terminal generation status.
func (r *run) execute(ctx context.Context) {
	defer func() {
		if !r.finished {
			r.fail(ctx, plans.StageFinalize, ErrorStore, plans.OutcomeError, nil)
		}
	}()
	r.loadProject(ctx)
	r.progress(ctx, plans.StageIntent)
	intent, ok := r.intent(ctx)
	if !ok {
		return
	}
	if len(intent.Blocking()) > 0 {
		r.block(ctx, intent)
		return
	}
	r.progress(ctx, plans.StageContext)
	built, ok := r.context(ctx, intent)
	if !ok {
		return
	}
	r.progress(ctx, plans.StageGenerate)
	plan, parsed, findings, ok := r.generate(ctx, intent, built)
	if !ok {
		return
	}
	report := r.evaluate(ctx, plan, parsed, findings, built, nil, plans.OriginGenerated, nil)
	var previous *ir.Plan
	for attempt := 1; !report.Valid() && !report.Blocked() && attempt <= r.service.options.MaxRepairs; attempt++ {
		r.progress(ctx, plans.StageRepair)
		current := plan
		if parsed {
			previous = &current
		}
		repaired, repairedParsed, repairedFindings, reply, ok := r.repair(ctx, attempt, intent, plan, parsed, report, built)
		if !ok {
			return
		}
		before := report
		plan, parsed = repaired, repairedParsed
		r.repairs++
		report = r.evaluate(ctx, plan, parsed, repairedFindings, built, previous, plans.OriginRepaired, func() {
			r.record(ctx, plans.StageRepair, roleOf(modelgateway.RoleRepair), reply, outcomeOfParse(repairedParsed), map[string]any{
				"attempt": attempt, "fixedCodes": difference(codesOf(before), codesOf(report)), "remainingCodes": codesOf(report),
			})
		})
	}
	if !report.Valid() {
		r.fail(ctx, plans.StageValidate, ErrorPlanInvalid, plans.OutcomeInvalid, &report)
		return
	}
	for round := 1; round <= r.service.options.MaxCriticRounds; round++ {
		r.progress(ctx, plans.StageCritic)
		verdict, ok := r.critic(ctx, intent, plan, report, built)
		if !ok || verdict.Verdict != ir.VerdictRevise || len(ir.Errors(verdict.Findings())) == 0 {
			break
		}
		revised, revisedReport, ok := r.revise(ctx, round, intent, plan, verdict, built)
		if !ok {
			break
		}
		plan, report = revised, revisedReport
	}
	r.finalize(ctx, plan, report)
}

// complete calls one role under the remaining pipeline time, capped per call.
func (r *run) complete(ctx context.Context, role modelgateway.Role, task, schema string) (modelgateway.Reply, error) {
	timeout := maxCallTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < timeout {
			timeout = remaining
		}
	}
	if timeout <= 0 {
		return modelgateway.Reply{}, context.DeadlineExceeded
	}
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if r.service.options.Gateway == nil {
		return modelgateway.Reply{}, modelgateway.ErrRoleUnavailable
	}
	reply, err := r.service.options.Gateway.Complete(callCtx, role, modelgateway.Request{User: task, SchemaName: schema})
	r.service.options.Metrics.CountTokens(string(role), reply.InputTokens, reply.OutputTokens)
	if err != nil && callCtx.Err() != nil {
		// The transport wraps a dead context in its own error; the deadline
		// is what happened.
		return reply, fmt.Errorf("%w: %v", callCtx.Err(), err)
	}
	return reply, err
}

// classify maps a stage failure to an outcome and the error code a reader
// sees.
func (r *run) classify(err error) (outcome, code string) {
	switch {
	case r.service.workerCtx.Err() != nil:
		return plans.OutcomeError, ErrorShutdown
	case errors.Is(err, context.DeadlineExceeded):
		return plans.OutcomeTimeout, ErrorTimeout
	case errors.Is(err, context.Canceled):
		return plans.OutcomeError, ErrorShutdown
	case errors.Is(err, modelgateway.ErrRateLimited):
		return plans.OutcomeError, ErrorRoleRateLimited
	case errors.Is(err, modelgateway.ErrRoleUnavailable):
		return plans.OutcomeError, ErrorPlannerUnavailable
	case errors.Is(err, modelgateway.ErrRequestTooLarge):
		return plans.OutcomeError, ErrorRequestTooLarge
	case errors.Is(err, modelgateway.ErrEmptyReply):
		return plans.OutcomeInvalid, ErrorUpstream
	}
	return plans.OutcomeError, ErrorUpstream
}

// stageFailed records the failed call and closes the generation.
func (r *run) stageFailed(ctx context.Context, stage string, role modelgateway.Role, reply modelgateway.Reply, err error) {
	outcome, code := r.classify(err)
	r.record(ctx, stage, roleOf(role), reply, outcome, map[string]any{"code": code})
	r.fail(ctx, stage, code, outcome, nil)
}

// loadProject reads the linked project before the first model call.
//
// The classifier decides whether a request can be planned at all, and it made
// that decision knowing only the sentence the person typed. Asked to work from
// a project brief it could not see, it did the reasonable thing and asked
// where the brief was — a question the linked project answers, from a stage
// that runs before the project is ever read.
//
// Best effort: a project that cannot be read costs the classifier context, not
// the plan. The context stage reads it again rather than sharing this value,
// because that stage must reflect the project as of its own moment and one
// extra bounded read is cheaper than reasoning about which is authoritative.
func (r *run) loadProject(ctx context.Context) {
	if r.input.ProjectID == nil || r.service.options.Sources.Project == nil {
		return
	}
	data, err := r.service.options.Sources.Project.Project(ctx, r.header.WorkspaceID, *r.input.ProjectID)
	if err != nil {
		return
	}
	r.project = &data
}

func (r *run) intent(ctx context.Context) (ir.IntentAnalysis, bool) {
	started := r.now()
	reply, err := r.complete(ctx, modelgateway.RoleClassifier, intentMessage(r.input.Prompt, r.input.Hint, r.project), "IntentAnalysis")
	if err != nil {
		r.stageFailed(ctx, plans.StageIntent, modelgateway.RoleClassifier, reply, err)
		return ir.IntentAnalysis{}, false
	}
	analysis, findings := ir.ParseIntentReply(reply.Content)
	if !ir.Valid(findings) {
		// The classifier answered with something that is not an analysis. A
		// second call would be a retry of a paid call; the plan fails and
		// the person may regenerate.
		r.record(ctx, plans.StageIntent, roleOf(modelgateway.RoleClassifier), reply, plans.OutcomeInvalid, map[string]any{"codes": ir.Codes(findings)})
		r.fail(ctx, plans.StageIntent, "INTENT_INVALID", plans.OutcomeInvalid, nil)
		return ir.IntentAnalysis{}, false
	}
	r.record(ctx, plans.StageIntent, roleOf(modelgateway.RoleClassifier), reply, plans.OutcomeOK, map[string]any{
		"requirementCount": len(analysis.Requirements), "ambiguityCount": len(analysis.Ambiguities),
		"blocking": len(analysis.Blocking()) > 0, "durationMs": r.now().Sub(started).Milliseconds(),
	})
	return analysis, true
}

// block stops before a plan exists: the questions are stored as blocking
// assumptions on a goal-only skeleton so the preview can ask them, and the
// plan waits in validation status blocked.
func (r *run) block(ctx context.Context, intent ir.IntentAnalysis) {
	plan := ir.Plan{Schema: ir.Schema, Version: ir.Version, Goal: ir.Goal{TempID: "g_pending", Title: clampTitle(intent.Goal)}}
	questions := []map[string]any{}
	for _, ambiguity := range intent.Ambiguities {
		text := ambiguity.Question
		if text == "" {
			text = ambiguity.Description
		}
		plan.Assumptions = append(plan.Assumptions, ir.Assumption{
			ID: "a_" + ambiguity.ID, Description: text, Confidence: "low", UserEditable: true, Blocking: ambiguity.Blocking,
		})
		if ambiguity.Blocking {
			questions = append(questions, map[string]any{"id": "a_" + ambiguity.ID, "question": text})
		}
	}
	report := validate.Validate(validate.Input{Plan: plan, Permissions: r.permissions, AllUnknown: true, Workspace: validate.Workspace{ID: r.header.WorkspaceID}})
	r.save(ctx, plans.OriginGenerated, plan, report, nil)
	r.finish(ctx, plans.GenerationSucceeded, nil, plans.ValidationBlocked, nil)
	r.emit(ctx, TopicPlanBlocked, map[string]any{"stage": plans.StageIntent, "status": plans.GenerationSucceeded, "questions": questions})
}

func (r *run) context(ctx context.Context, intent ir.IntentAnalysis) (Context, bool) {
	started := r.now()
	built, err := BuildContext(ctx, r.service.options.Sources, BuildInput{
		WorkspaceID: r.header.WorkspaceID, ProjectID: r.input.ProjectID, Intent: intent, Prompt: r.input.Prompt,
		Hint: r.input.Hint, Permissions: r.permissions, BudgetBytes: r.service.options.ContextBudgetBytes,
	})
	if err != nil {
		outcome, code := r.classify(err)
		r.record(ctx, plans.StageContext, nil, modelgateway.Reply{Duration: r.now().Sub(started)}, outcome, map[string]any{"code": code})
		r.fail(ctx, plans.StageContext, code, outcome, nil)
		return Context{}, false
	}
	detail, _ := json.Marshal(built.Detail)
	var asMap map[string]any
	_ = json.Unmarshal(detail, &asMap)
	r.record(ctx, plans.StageContext, nil, modelgateway.Reply{Duration: r.now().Sub(started)}, plans.OutcomeOK, asMap)
	return built, true
}

func (r *run) generate(ctx context.Context, intent ir.IntentAnalysis, built Context) (ir.Plan, bool, []ir.Finding, bool) {
	task, err := generateMessage(r.input.Prompt, intent, built.Rendered)
	if err != nil {
		r.stageFailed(ctx, plans.StageGenerate, modelgateway.RolePlanner, modelgateway.Reply{}, err)
		return ir.Plan{}, false, nil, false
	}
	reply, err := r.complete(ctx, modelgateway.RolePlanner, task, "BerryPlan")
	if err != nil {
		r.stageFailed(ctx, plans.StageGenerate, modelgateway.RolePlanner, reply, err)
		return ir.Plan{}, false, nil, false
	}
	plan, findings := ir.ParsePlanReply(reply.Content)
	parsed := parsedPlan(findings)
	detail := map[string]any{"codes": ir.Codes(findings)}
	if parsed {
		detail = map[string]any{"planVersion": r.version + 1}
	}
	r.record(ctx, plans.StageGenerate, roleOf(modelgateway.RolePlanner), reply, outcomeOfParse(parsed), detail)
	return plan, parsed, findings, true
}

// evaluate validates a parsed plan against the workspace, stores it as a
// version and records the validate stage. An unparsable reply is not
// stored; its findings stand in for the validator's.
func (r *run) evaluate(ctx context.Context, plan ir.Plan, parsed bool, findings []ir.Finding, built Context, previous *ir.Plan, origin string, before func()) validate.Report {
	var report validate.Report
	if parsed {
		report = validate.Validate(validate.Input{
			Plan: plan, Previous: previous, Catalog: built.Catalog, Workspace: built.Workspace, Agents: built.Agents,
			ExistingIssues: built.OpenIssues, ExistingWorkflows: built.Workflows, Permissions: built.Permissions,
		})
		r.save(ctx, origin, plan, report, nil)
	} else {
		report.Errors = ir.Errors(findings)
		report.Warnings = ir.Warnings(findings)
	}
	if before != nil {
		before()
	}
	r.record(ctx, plans.StageValidate, nil, modelgateway.Reply{}, outcomeOfValid(report.Valid()), map[string]any{
		"errors": ir.Codes(report.Errors), "warnings": ir.Codes(report.Warnings), "stored": parsed,
	})
	return report
}

func (r *run) repair(ctx context.Context, attempt int, intent ir.IntentAnalysis, plan ir.Plan, parsed bool, report validate.Report, built Context) (ir.Plan, bool, []ir.Finding, modelgateway.Reply, bool) {
	var current *ir.Plan
	if parsed {
		current = &plan
	}
	task, err := repairMessage(r.input.Prompt, intent, current, report.Findings(), built.Rendered)
	if err != nil {
		r.stageFailed(ctx, plans.StageRepair, modelgateway.RoleRepair, modelgateway.Reply{}, err)
		return ir.Plan{}, false, nil, modelgateway.Reply{}, false
	}
	reply, err := r.complete(ctx, modelgateway.RoleRepair, task, "BerryPlan")
	if err != nil {
		r.stageFailed(ctx, plans.StageRepair, modelgateway.RoleRepair, reply, err)
		return ir.Plan{}, false, nil, modelgateway.Reply{}, false
	}
	repaired, findings := ir.ParsePlanReply(reply.Content)
	_ = attempt
	return repaired, parsedPlan(findings), findings, reply, true
}

func (r *run) critic(ctx context.Context, intent ir.IntentAnalysis, plan ir.Plan, report validate.Report, built Context) (ir.CriticVerdict, bool) {
	task, err := criticMessage(r.input.Prompt, intent, plan, report, built.Rendered)
	if err != nil {
		outcome, code := r.classify(err)
		r.record(ctx, plans.StageCritic, roleOf(modelgateway.RoleCritic), modelgateway.Reply{}, outcome, map[string]any{"code": code})
		return ir.CriticVerdict{}, false
	}
	reply, err := r.complete(ctx, modelgateway.RoleCritic, task, "CriticVerdict")
	if err != nil {
		// The critic never blocks a valid plan: its failure is recorded and
		// the plan finalizes as validated.
		outcome, code := r.classify(err)
		r.record(ctx, plans.StageCritic, roleOf(modelgateway.RoleCritic), reply, outcome, map[string]any{"code": code})
		if r.service.workerCtx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			r.fail(ctx, plans.StageCritic, code, outcome, nil)
			r.finished = true
		}
		return ir.CriticVerdict{}, false
	}
	verdict, findings := ir.ParseCriticReply(reply.Content)
	if !ir.Valid(findings) {
		r.record(ctx, plans.StageCritic, roleOf(modelgateway.RoleCritic), reply, plans.OutcomeInvalid, map[string]any{"codes": ir.Codes(findings)})
		return ir.CriticVerdict{}, false
	}
	r.record(ctx, plans.StageCritic, roleOf(modelgateway.RoleCritic), reply, plans.OutcomeOK, map[string]any{
		"verdict": verdict.Verdict, "problemCodes": ir.Codes(verdict.Findings()),
	})
	return verdict, true
}

// revise applies one critic round through the repair role. The revision is
// stored only when it validates; otherwise the valid plan stands.
func (r *run) revise(ctx context.Context, round int, intent ir.IntentAnalysis, plan ir.Plan, verdict ir.CriticVerdict, built Context) (ir.Plan, validate.Report, bool) {
	r.progress(ctx, plans.StageRepair)
	task, err := repairMessage(r.input.Prompt, intent, &plan, verdict.Findings(), built.Rendered)
	if err != nil {
		outcome, code := r.classify(err)
		r.record(ctx, plans.StageRepair, roleOf(modelgateway.RoleRepair), modelgateway.Reply{}, outcome, map[string]any{"code": code, "critic": round})
		return plan, validate.Report{}, false
	}
	reply, err := r.complete(ctx, modelgateway.RoleRepair, task, "BerryPlan")
	if err != nil {
		outcome, code := r.classify(err)
		r.record(ctx, plans.StageRepair, roleOf(modelgateway.RoleRepair), reply, outcome, map[string]any{"code": code, "critic": round})
		if r.service.workerCtx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
			r.fail(ctx, plans.StageRepair, code, outcome, nil)
			r.finished = true
		}
		return plan, validate.Report{}, false
	}
	revised, findings := ir.ParsePlanReply(reply.Content)
	if !parsedPlan(findings) {
		r.record(ctx, plans.StageRepair, roleOf(modelgateway.RoleRepair), reply, plans.OutcomeInvalid, map[string]any{"critic": round, "remainingCodes": ir.Codes(findings)})
		return plan, validate.Report{}, false
	}
	report := validate.Validate(validate.Input{
		Plan: revised, Previous: &plan, Catalog: built.Catalog, Workspace: built.Workspace, Agents: built.Agents,
		ExistingIssues: built.OpenIssues, ExistingWorkflows: built.Workflows, Permissions: built.Permissions,
	})
	r.record(ctx, plans.StageRepair, roleOf(modelgateway.RoleRepair), reply, outcomeOfValid(report.Valid()), map[string]any{
		"critic": round, "fixedCodes": ir.Codes(verdict.Findings()), "remainingCodes": ir.Codes(report.Errors),
	})
	if !report.Valid() {
		// A revision that breaks the plan is dropped: the critic can advise
		// but never leave the person with an invalid plan.
		return plan, validate.Report{}, false
	}
	critic, _ := json.Marshal(verdict)
	r.save(ctx, plans.OriginCriticRevised, revised, report, critic)
	return revised, report, true
}

func (r *run) finalize(ctx context.Context, plan ir.Plan, report validate.Report) {
	confidence := math.Min(math.Max(plan.Confidence, 0), 1) - confidencePenalty*float64(r.repairs)
	if confidence < confidenceFloor {
		confidence = confidenceFloor
	}
	confidence = math.Round(confidence*1000) / 1000
	r.finish(ctx, plans.GenerationSucceeded, nil, plans.ValidationValid, &confidence)
	r.emit(ctx, TopicPlanGenerated, map[string]any{
		"stage": plans.StageFinalize, "status": plans.GenerationSucceeded, "version": r.version,
		"validationStatus": plans.ValidationValid, "confidence": confidence, "repairs": r.repairs,
		"warnings": ir.Codes(report.Warnings), "risk": report.Risk,
	})
}

// fail closes the generation with a code and a last progress fact.
func (r *run) fail(ctx context.Context, stage, code, outcome string, report *validate.Report) {
	if r.finished {
		return
	}
	message := code
	if code != ErrorPlanInvalid && code != ErrorShutdown {
		message = code + " at " + stage
	}
	validationStatus := ""
	if code == ErrorPlanInvalid {
		validationStatus = plans.ValidationInvalid
	}
	r.finish(ctx, plans.GenerationFailed, &message, validationStatus, nil)
	detail := map[string]any{"stage": stage, "status": plans.GenerationFailed, "error": message, "outcome": outcome}
	if code == ErrorPlanInvalid && report != nil {
		detail["errors"] = ir.Codes(report.Errors)
	}
	r.emit(ctx, TopicPlanUpdated, detail)
	r.service.options.Logger.Warn("plan generation failed", "planId", r.header.ID, "stage", stage, "error", message)
}

func (r *run) finish(ctx context.Context, status string, message *string, validationStatus string, confidence *float64) {
	if r.finished {
		return
	}
	r.finished = true
	writeCtx, cancel := r.bookkeeping(ctx)
	defer cancel()
	var plannerVersion *string
	if r.service.options.PlannerVersion != "" {
		version := r.service.options.PlannerVersion
		plannerVersion = &version
	}
	if err := r.service.options.Store.FinishGeneration(writeCtx, plans.FinishGenerationParams{
		PlanID: r.header.ID, Status: status, Error: message, ValidationStatus: validationStatus, Confidence: confidence,
		PlannerVersion: plannerVersion, Now: r.now(),
	}); err != nil {
		r.service.options.Logger.Error("record plan generation outcome", "planId", r.header.ID, "error", err)
	}
}

// save stores one IR version with its validation, marking the required
// connections with their live status first.
func (r *run) save(ctx context.Context, origin string, plan ir.Plan, report validate.Report, critic json.RawMessage) {
	for index := range plan.RequiredConnections {
		for _, connection := range report.RequiredConnections {
			if connection.Provider == plan.RequiredConnections[index].Provider {
				plan.RequiredConnections[index].Connected = connection.Connected
			}
		}
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		r.service.options.Logger.Error("encode plan version", "planId", r.header.ID, "error", err)
		return
	}
	status := plans.ValidationInvalid
	switch {
	case report.Blocked():
		status = plans.ValidationBlocked
	case report.Valid():
		status = plans.ValidationValid
	}
	writeCtx, cancel := r.bookkeeping(ctx)
	defer cancel()
	var plannerVersion *string
	if r.service.options.PlannerVersion != "" {
		version := r.service.options.PlannerVersion
		plannerVersion = &version
	}
	confidence := math.Min(math.Max(plan.Confidence, 0), 1)
	version, err := r.service.options.Store.SaveVersion(writeCtx, plans.SaveVersionParams{
		PlanID: r.header.ID, ExpectedVersion: r.version, Origin: origin, IR: encoded, IRVersion: ir.Version,
		Validation: report.JSON(), Critic: critic, ValidationStatus: status, Confidence: &confidence, PlannerVersion: plannerVersion,
		CreatedByType: "system", CreatedAt: r.now(), NewID: r.service.options.NewID,
	})
	if err != nil {
		r.service.options.Logger.Error("save plan version", "planId", r.header.ID, "error", err)
		return
	}
	r.version = version.Version
}

// record writes one planner_events row: stage, role, usage, outcome and a
// detail of codes and counts. Never the task text or the reply.
func (r *run) record(ctx context.Context, stage string, role *modelgateway.Role, reply modelgateway.Reply, outcome string, detail map[string]any) {
	writeCtx, cancel := r.bookkeeping(ctx)
	defer cancel()
	if detail == nil {
		detail = map[string]any{}
	}
	encoded, err := json.Marshal(detail)
	if err != nil {
		encoded = []byte(`{}`)
	}
	params := plans.RecordEventParams{
		ID: r.service.options.NewID(), PlanID: r.header.ID, Stage: stage, Outcome: outcome, Detail: encoded, OccurredAt: r.now(),
	}
	if role != nil {
		name := string(*role)
		params.Role = &name
		params.ModelProvider = optional(reply.Provider)
		params.ModelName = optional(reply.Model)
		params.PromptVersion = optional(reply.PromptVersion)
		input, output := reply.InputTokens, reply.OutputTokens
		params.InputTokens, params.OutputTokens = &input, &output
		params.CostMicros = reply.CostMicros
	}
	if reply.Duration > 0 {
		duration := reply.Duration.Milliseconds()
		params.DurationMS = &duration
	}
	if _, err := r.service.options.Store.RecordEvent(writeCtx, params); err != nil {
		r.service.options.Logger.Error("record planner event", "planId", r.header.ID, "stage", stage, "error", err)
	}
	r.service.options.Metrics.ObserveStage(stage, outcome, reply.Duration)
}

// progress mirrors the stage in progress to the workspace stream.
func (r *run) progress(ctx context.Context, stage string) {
	r.emit(ctx, TopicPlanUpdated, map[string]any{"stage": stage, "status": plans.GenerationRunning})
}

func (r *run) emit(ctx context.Context, topic string, detail map[string]any) {
	writeCtx, cancel := r.bookkeeping(ctx)
	defer cancel()
	event, err := r.service.options.Store.EmitPlanEvent(writeCtx, r.header.ID, topic, detail, r.service.options.NewID, r.now())
	if err != nil {
		r.service.options.Logger.Error("emit plan event", "planId", r.header.ID, "topic", topic, "error", err)
		return
	}
	r.service.publish(writeCtx, []ledger.Event{event})
}

func roleOf(role modelgateway.Role) *modelgateway.Role { return &role }

func optional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func parsedPlan(findings []ir.Finding) bool {
	for _, item := range findings {
		if item.Code == ir.CodePlanJSONInvalid || item.Code == ir.CodePlanSchemaInvalid {
			return false
		}
	}
	return true
}

func outcomeOfParse(parsed bool) string {
	if parsed {
		return plans.OutcomeOK
	}
	return plans.OutcomeInvalid
}

func outcomeOfValid(valid bool) string {
	if valid {
		return plans.OutcomeOK
	}
	return plans.OutcomeInvalid
}

func codesOf(report validate.Report) []string {
	return ir.Codes(report.Errors)
}

func difference(before, after []string) []string {
	remaining := map[string]bool{}
	for _, code := range after {
		remaining[code] = true
	}
	fixed := []string{}
	for _, code := range before {
		if !remaining[code] {
			fixed = append(fixed, code)
		}
	}
	return fixed
}

func clampTitle(title string) string {
	if title == "" {
		return "New goal"
	}
	if len(title) > 500 {
		return title[:500]
	}
	return title
}
