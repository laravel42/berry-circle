package plans

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/automation"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/issueid"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/planner/validate"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// Compilation turns an approved BerryPlan into rows: the goal is promoted,
// issues land on the board with the status the plan's rules give them,
// dependencies and approvals gate what must wait, and workflows are stored as
// drafts. Everything happens in one transaction, in the order the schema
// needs (an approval references its issue, so the issue comes first), and a
// failure leaves nothing but a compile_status of failed on the plan.

var (
	// ErrPlanInvalid means the stored IR does not pass the deterministic
	// checks; a stale "valid" never compiles.
	ErrPlanInvalid = errors.New("plan is not valid")
	// ErrCompileInProgress means another compile holds the plan.
	ErrCompileInProgress = errors.New("plan compile is in progress")
	// ErrCompileFailed is the base of every CompileError.
	ErrCompileFailed = errors.New("plan compile failed")
)

// InvalidPlanError carries the findings that stopped a compile.
type InvalidPlanError struct {
	Findings []ir.Finding
}

func (err *InvalidPlanError) Error() string { return ErrPlanInvalid.Error() }

func (err *InvalidPlanError) Unwrap() error { return ErrPlanInvalid }

// CompileError names the stage that failed and a client-safe message. Stage
// and Message are what the plan records as compile_error.
type CompileError struct {
	Stage   string
	Message string
	Err     error
}

func (err *CompileError) Error() string {
	return fmt.Sprintf("plan compile failed at %s: %s", err.Stage, err.Message)
}

func (err *CompileError) Unwrap() error { return ErrCompileFailed }

// CompileParams is one approve-and-compile request.
type CompileParams struct {
	PlanID  uuid.UUID
	ActorID uuid.UUID
	Now     time.Time
	// NewID mints every row and event id; nil falls back to random ids.
	NewID func() uuid.UUID
	// Catalog informs workflow validation and risk; nil skips the
	// integration rules, which is only right in tests.
	Catalog automation.Catalog
}

// CompileResult is what the compile wrote, with the temporary ids mapped to
// rows and every fact to publish after commit.
type CompileResult struct {
	Plan        PlanHeader
	IR          ir.Plan
	GoalID      uuid.UUID
	IssueIDs    map[string]uuid.UUID
	WorkflowIDs map[string]uuid.UUID
	ApprovalIDs map[string]uuid.UUID
	// ActivateOnApprove lists the workflows the plan asked to activate; the
	// caller decides after commit whether the actor may.
	ActivateOnApprove []uuid.UUID
	// Events are the goal, approval, workflow and plan facts in emission
	// order; IssueEvents the issue.created facts.
	Events      []ledger.Event
	IssueEvents []core.IssueMutationEvent
	// AlreadyCompiled is true when the plan had compiled before this call and
	// nothing was written: a second approve is a no-op.
	AlreadyCompiled bool
}

// Stages, as recorded in compile_error and planner_events.
const (
	stagePlan      = "plan"
	stageGoal      = "goal"
	stageBoard     = "board"
	stageIssues    = "issues"
	stageLinks     = "links"
	stageApprovals = "approvals"
	stageWorkflows = "workflows"
	stageFinalize  = "finalize"
)

// defaultLabelColor is what a label created for a required capability gets;
// people recolour labels, the compiler does not choose for them.
const defaultLabelColor = "#6b7280"

// Compile approves and compiles a generated plan (§10). It is idempotent: a
// plan that already compiled returns its result with AlreadyCompiled set and
// writes nothing.
func (repository *Repository) Compile(ctx context.Context, params CompileParams) (CompileResult, error) {
	if params.PlanID == uuid.Nil || params.ActorID == uuid.Nil || params.Now.IsZero() {
		return CompileResult{}, errors.New("plan compile parameters are invalid")
	}
	newID := params.NewID
	if newID == nil {
		newID = uuid.New
	}
	result, err := repository.compile(ctx, params, newID)
	var failure *CompileError
	if errors.As(err, &failure) {
		if recordErr := repository.recordCompileFailure(ctx, params, failure, newID); recordErr != nil {
			return CompileResult{}, recordErr
		}
	}
	return result, err
}

func (repository *Repository) compile(ctx context.Context, params CompileParams, newID func() uuid.UUID) (CompileResult, error) {
	now := params.Now.UTC()
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return CompileResult{}, errors.New("begin plan compile")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	header, err := getHeader(ctx, tx, params.PlanID, true)
	if err != nil {
		return CompileResult{}, err
	}
	if header.Source == SourceOrchestrator {
		return CompileResult{}, ErrNotOpen
	}
	if header.CompileStatus == CompileSucceeded {
		plan, _ := ir.Parse(header.IR)
		return CompileResult{Plan: header, IR: plan, AlreadyCompiled: true, GoalID: derefUUID(header.GoalID)}, nil
	}
	if header.CompileStatus == CompileRunning {
		return CompileResult{}, ErrCompileInProgress
	}
	switch header.Status {
	case StatusDraft, StatusPendingApproval, StatusApproved:
	default:
		return CompileResult{}, ErrNotOpen
	}
	if header.ValidationStatus != ValidationValid || len(header.IR) == 0 {
		return CompileResult{}, &InvalidPlanError{}
	}
	plan, err := ir.Parse(header.IR)
	if err != nil {
		return CompileResult{}, &InvalidPlanError{Findings: []ir.Finding{{Path: "", Code: "PLAN_INVALID_JSON", Message: err.Error(), Severity: automation.SeverityError}}}
	}
	if findings := Validate(plan, params.Catalog); !ir.Valid(findings) {
		return CompileResult{}, &InvalidPlanError{Findings: findings}
	}
	if header.GoalID == nil {
		return CompileResult{}, &CompileError{Stage: stageGoal, Message: "plan has no goal"}
	}

	result := CompileResult{
		Plan:        header,
		IR:          plan,
		GoalID:      *header.GoalID,
		IssueIDs:    map[string]uuid.UUID{},
		WorkflowIDs: map[string]uuid.UUID{},
		ApprovalIDs: map[string]uuid.UUID{},
	}

	// 2. The plan is approved from here on; the 010 trigger reads the status,
	//    so issues linked below may move to todo once released.
	if _, err := tx.Exec(
		ctx,
		`UPDATE plans
		    SET status = 'approved', approved_by = $2, approved_at = $3, compile_status = 'running',
		        compile_error = NULL, updated_at = $3
		  WHERE id = $1`,
		header.ID, params.ActorID, now,
	); err != nil {
		return CompileResult{}, &CompileError{Stage: stagePlan, Message: "approve plan", Err: err}
	}
	if _, resolved, err := approvals.ResolvePlanIn(ctx, tx, header.ID, params.ActorID, now, newID); err != nil {
		return CompileResult{}, &CompileError{Stage: stagePlan, Message: "resolve plan approval", Err: err}
	} else if resolved != nil {
		result.Events = append(result.Events, *resolved)
	}
	planEvent, err := writePlanEvent(ctx, tx, "plan.approved", header, map[string]any{"approvedBy": params.ActorID}, newID, now)
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stagePlan, Message: "record plan approval", Err: err}
	}
	result.Events = append(result.Events, planEvent)

	// 3. Goal.
	goal, goalEvent, err := goals.PlanIn(ctx, tx, *header.GoalID, plan.Goal.Title, plan.Goal.Description, plan.Goal.ProjectID, params.ActorID, now, newID)
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stageGoal, Message: safeMessage(err), Err: err}
	}
	result.Events = append(result.Events, goalEvent)

	// 4. Issues, blockers first.
	boardID, err := compileBoard(ctx, tx, header)
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stageBoard, Message: safeMessage(err), Err: err}
	}
	blockers := effectiveBlockers(plan)
	ordered, ok := ir.TopologicalIssues(withBlockers(plan.Issues, blockers))
	if !ok {
		return CompileResult{}, &InvalidPlanError{Findings: []ir.Finding{{Path: "/issues", Code: "DEP_CYCLE", Message: "Issue dependencies form a cycle.", Severity: automation.SeverityError}}}
	}
	plannedApprovals := indexApprovals(plan)
	type gate struct {
		issueID uuid.UUID
		planned *ir.Approval
		policy  *integrationcore.Policy
		issue   ir.Issue
	}
	var gates []gate
	for _, issue := range ordered {
		issueID := newID()
		text := issue.Title
		if issue.Description != nil {
			text += "\n" + *issue.Description
		}
		var matched *integrationcore.Policy
		if policy, ok := integrationcore.MatchPolicy(text); ok {
			matched = &policy
		}
		planned := plannedApprovals["issue:"+issue.TempID]
		gated := issue.RequiresApproval || matched != nil || planned != nil
		status := "todo"
		switch {
		case gated:
			status = "backlog"
		case len(blockers[issue.TempID]) > 0:
			status = "blocked"
		}
		assignee, err := compileAssignee(ctx, tx, header.WorkspaceID, issue.SuggestedAgentID)
		if err != nil {
			return CompileResult{}, &CompileError{Stage: stageIssues, Message: safeMessage(err), Err: err}
		}
		if err := insertCompiledIssue(ctx, tx, compiledIssue{
			ID: issueID, BoardID: boardID, Issue: issue, Status: status, Assignee: assignee,
			ActorID: params.ActorID, AutoGate: header.AutoGate, Now: now,
		}); err != nil {
			return CompileResult{}, &CompileError{Stage: stageIssues, Message: safeMessage(err), Err: err}
		}
		result.IssueIDs[issue.TempID] = issueID
		if gated {
			gates = append(gates, gate{issueID: issueID, planned: planned, policy: matched, issue: issue})
		}
	}
	// 4b. Links: plan, goal, project, labels, then dependencies.
	for _, issue := range ordered {
		issueID := result.IssueIDs[issue.TempID]
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO plan_issues (workspace_id, issue_id, plan_id, created_at) VALUES ($1, $2, $3, $4)`,
			header.WorkspaceID, issueID, header.ID, now,
		); err != nil {
			return CompileResult{}, &CompileError{Stage: stageLinks, Message: "link plan issue", Err: err}
		}
		if err := goals.LinkIssueIn(ctx, tx, header.WorkspaceID, goal.ID, issueID, params.ActorID, now); err != nil {
			return CompileResult{}, &CompileError{Stage: stageLinks, Message: "link goal issue: " + safeMessage(err), Err: err}
		}
		if goal.ProjectID != nil {
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO issue_project_links (workspace_id, issue_id, project_id, linked_by, created_at)
				 VALUES ($1, $2, $3, $4, $5)`,
				header.WorkspaceID, issueID, *goal.ProjectID, params.ActorID, now,
			); err != nil {
				return CompileResult{}, &CompileError{Stage: stageLinks, Message: "link project issue", Err: err}
			}
		}
		if err := attachCapabilityLabels(ctx, tx, header.WorkspaceID, issueID, issue.RequiredCapabilities, params.ActorID, now, newID); err != nil {
			return CompileResult{}, &CompileError{Stage: stageLinks, Message: "attach labels: " + safeMessage(err), Err: err}
		}
	}
	for _, issue := range ordered {
		for _, blocker := range sortedKeys(blockers[issue.TempID]) {
			if err := core.InsertIssueDependency(ctx, tx, core.AddIssueDependencyParams{
				WorkspaceID:      header.WorkspaceID,
				IssueID:          result.IssueIDs[issue.TempID],
				DependsOnIssueID: result.IssueIDs[blocker],
				CreatedBy:        params.ActorID,
				CreatedAt:        now,
			}); err != nil {
				return CompileResult{}, &CompileError{Stage: stageLinks, Message: "record dependency: " + safeMessage(err), Err: err}
			}
		}
	}
	// 4c. issue.created facts, once every link the payload reads is in place.
	for _, issue := range ordered {
		events, err := core.RecordIssueEvents(ctx, tx, core.IssueEventParams{
			IssueID:    result.IssueIDs[issue.TempID],
			Kind:       core.IssueEventCreated,
			Actor:      &core.ActorKey{Type: "user", ID: params.ActorID},
			OccurredAt: now,
			NewID:      newID,
		})
		if err != nil {
			return CompileResult{}, &CompileError{Stage: stageIssues, Message: "record issue events", Err: err}
		}
		result.IssueEvents = append(result.IssueEvents, events...)
	}
	// 4d. Start gates, after the issues they reference exist.
	for _, item := range gates {
		approvalParams := approvals.CreateParams{
			ID:              newID(),
			WorkspaceID:     header.WorkspaceID,
			Kind:            approvals.KindIssueStart,
			Risk:            approvals.RiskMedium,
			GoalID:          &goal.ID,
			PlanID:          &header.ID,
			IssueID:         &item.issueID,
			RequestedByType: approvals.ActorUser,
			RequestedBy:     &params.ActorID,
			RequestedAt:     now,
			NewID:           newID,
		}
		approvalParams.Title, approvalParams.Description = gateTitle(ctx, tx, item.issueID, item.issue)
		if item.policy != nil {
			approvalParams.Risk = approvals.Risk(item.policy.Risk)
			description := item.policy.Description + " (" + item.policy.ID + ")."
			approvalParams.Description = &description
		}
		if item.planned != nil {
			applyPlannedApprover(&approvalParams, *item.planned, now)
		} else {
			approvalParams.RequestedFromRole = "admin"
		}
		approval, event, err := approvals.CreateIn(ctx, tx, approvalParams)
		if err != nil {
			return CompileResult{}, &CompileError{Stage: stageApprovals, Message: "request issue approval: " + safeMessage(err), Err: err}
		}
		if item.planned != nil {
			result.ApprovalIDs[item.planned.TempID] = approval.ID
		}
		result.Events = append(result.Events, event)
	}

	// 5. Workflows, as drafts.
	for _, workflow := range plan.Workflows {
		definition := workflow.Definition()
		for _, planned := range plan.Approvals {
			if planned.Target.Kind == "step" && planned.Target.TempID == workflow.TempID {
				definition = insertApprovalStep(definition, planned)
			}
		}
		if report := automation.ValidateDefinition(definition, automation.ValidateOptions{Catalog: params.Catalog}); !report.Valid() {
			return CompileResult{}, &InvalidPlanError{Findings: prefixed("/workflows/"+workflow.TempID, report.Errors)}
		}
		created, event, err := automationrepo.CreateIn(ctx, tx, automationrepo.CreateParams{
			ID:          newID(),
			WorkspaceID: header.WorkspaceID,
			ProjectID:   goal.ProjectID,
			GoalID:      &goal.ID,
			Name:        workflow.Name,
			Description: workflow.Description,
			Definition:  definition,
			Engine:      automationrepo.EngineNative,
			Catalog:     params.Catalog,
			CreatedBy:   params.ActorID,
			CreatedAt:   now,
			NewID:       newID,
		})
		if err != nil {
			return CompileResult{}, &CompileError{Stage: stageWorkflows, Message: "create workflow: " + safeMessage(err), Err: err}
		}
		result.WorkflowIDs[workflow.TempID] = created.ID
		result.Events = append(result.Events, event)
		if workflow.ActivateOnApprove {
			result.ActivateOnApprove = append(result.ActivateOnApprove, created.ID)
		}
	}
	// 6. Planned approvals on workflows become activation gates.
	for _, planned := range plan.Approvals {
		if planned.Target.Kind != "workflow" {
			continue
		}
		automationID, ok := result.WorkflowIDs[planned.Target.TempID]
		if !ok {
			continue
		}
		approvalParams := approvals.CreateParams{
			ID:              newID(),
			WorkspaceID:     header.WorkspaceID,
			Kind:            approvals.KindAutomationActivation,
			Risk:            approvals.RiskMedium,
			Title:           planned.Title,
			Description:     planned.Description,
			GoalID:          &goal.ID,
			PlanID:          &header.ID,
			AutomationID:    &automationID,
			RequestedByType: approvals.ActorUser,
			RequestedBy:     &params.ActorID,
			RequestedAt:     now,
			NewID:           newID,
		}
		applyPlannedApprover(&approvalParams, planned, now)
		approval, event, err := approvals.CreateIn(ctx, tx, approvalParams)
		if err != nil {
			return CompileResult{}, &CompileError{Stage: stageApprovals, Message: "request workflow approval: " + safeMessage(err), Err: err}
		}
		result.ApprovalIDs[planned.TempID] = approval.ID
		result.Events = append(result.Events, event)
	}

	// 7. Finalise the plan: annotated IR, a version snapshot, the stage record.
	plan.Compiled = &ir.Compiled{
		GoalID: goal.ID, IssueIDs: result.IssueIDs, WorkflowIDs: result.WorkflowIDs, ApprovalIDs: result.ApprovalIDs,
		CompiledAt: now.Format(time.RFC3339Nano),
	}
	annotated, err := json.Marshal(plan)
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "encode compiled plan", Err: err}
	}
	version := header.CurrentVersion + 1
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO plan_versions (
		    id, workspace_id, plan_id, version, origin, ir, ir_version, validation, created_by_type, created_by, created_at
		 ) VALUES ($1, $2, $3, $4, 'edited', $5::jsonb, '1', '{}'::jsonb, 'user', $6, $7)`,
		newID(), header.WorkspaceID, header.ID, version, string(annotated), params.ActorID, now,
	); err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "snapshot compiled plan", Err: err}
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE plans
		    SET compile_status = 'succeeded', compiled_at = $2, ir = $3::jsonb, current_version = $4, updated_at = $2
		  WHERE id = $1`,
		header.ID, now, string(annotated), version,
	); err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "finish compile", Err: err}
	}
	detail, _ := json.Marshal(plan.Compiled)
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO planner_events (
		    id, workspace_id, plan_id, sequence, stage, outcome, detail, occurred_at
		 ) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM planner_events WHERE plan_id = $3), 'compile', 'ok', $4::jsonb, $5)`,
		newID(), header.WorkspaceID, header.ID, string(detail), now,
	); err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "record compile stage", Err: err}
	}
	compiled, err := getHeader(ctx, tx, header.ID, false)
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "read compiled plan", Err: err}
	}
	compiledEvent, err := writePlanEvent(ctx, tx, "plan.compiled", compiled, map[string]any{"compiled": plan.Compiled}, newID, now.Add(time.Microsecond))
	if err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "record compile fact", Err: err}
	}
	result.Events = append(result.Events, compiledEvent)
	result.Plan = compiled
	result.IR = plan
	if err := tx.Commit(ctx); err != nil {
		return CompileResult{}, &CompileError{Stage: stageFinalize, Message: "commit compile", Err: err}
	}
	return result, nil
}

// recordCompileFailure leaves the plan approved with compile_status failed
// so the same actor can retry through POST /compile, and says why.
func (repository *Repository) recordCompileFailure(ctx context.Context, params CompileParams, failure *CompileError, newID func() uuid.UUID) error {
	now := params.Now.UTC()
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin compile failure record")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	message := failure.Stage + ": " + failure.Message
	if len(message) > 500 {
		message = message[:500]
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE plans
		    SET status = 'approved', approved_by = COALESCE(approved_by, $2), approved_at = COALESCE(approved_at, $3),
		        compile_status = 'failed', compile_error = $4, updated_at = $3
		  WHERE id = $1 AND status IN ('draft', 'pending_approval', 'approved')`,
		params.PlanID, params.ActorID, now, message,
	); err != nil {
		return classifyGeneratedWrite("record compile failure", err)
	}
	header, err := getHeader(ctx, tx, params.PlanID, false)
	if err != nil {
		return err
	}
	detail, _ := json.Marshal(map[string]string{"failedStage": failure.Stage})
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO planner_events (
		    id, workspace_id, plan_id, sequence, stage, outcome, detail, occurred_at
		 ) VALUES ($1, $2, $3, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM planner_events WHERE plan_id = $3), 'compile', 'error', $4::jsonb, $5)`,
		newID(), header.WorkspaceID, header.ID, string(detail), now,
	); err != nil {
		return classifyGeneratedWrite("record compile failure stage", err)
	}
	if _, err := writePlanEvent(ctx, tx, "plan.compile_failed", header, map[string]any{"stage": failure.Stage, "message": failure.Message}, newID, now); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit compile failure record")
	}
	return nil
}

// Validate runs the deterministic checks the compiler trusts: the IR's
// structure and every workflow definition. The planner's semantic validator
// builds on this; until it lands, this is what "valid" means.
func Validate(plan ir.Plan, catalog automation.Catalog) []ir.Finding {
	findings := ir.CheckStructure(plan)
	for index, workflow := range plan.Workflows {
		report := automation.ValidateDefinition(workflow.Definition(), automation.ValidateOptions{Catalog: catalog})
		prefix := "/workflows/" + fmt.Sprint(index)
		findings = append(findings, prefixed(prefix, report.Errors)...)
		findings = append(findings, prefixed(prefix, report.Warnings)...)
	}
	return findings
}

// PlanRisk is the plan's risk class, shared with the planner's validator so
// the approve gate and the preview agree.
func PlanRisk(plan ir.Plan, catalog automation.Catalog) automation.Risk {
	return validate.Risk(plan, catalog)
}

func prefixed(prefix string, findings []ir.Finding) []ir.Finding {
	out := make([]ir.Finding, 0, len(findings))
	for _, item := range findings {
		item.Path = prefix + item.Path
		out = append(out, item)
	}
	return out
}

// effectiveBlockers merges issue.dependsOn with dependencies[] of kind
// blocks between two issues, so both spellings gate the same way.
func effectiveBlockers(plan ir.Plan) map[string]map[string]bool {
	issues := map[string]bool{}
	for _, issue := range plan.Issues {
		issues[issue.TempID] = true
	}
	blockers := map[string]map[string]bool{}
	add := func(dependent, blocker string) {
		if !issues[dependent] || !issues[blocker] || dependent == blocker {
			return
		}
		if blockers[dependent] == nil {
			blockers[dependent] = map[string]bool{}
		}
		blockers[dependent][blocker] = true
	}
	for _, issue := range plan.Issues {
		for _, blocker := range issue.DependsOn {
			add(issue.TempID, blocker)
		}
	}
	for _, dependency := range plan.Dependencies {
		if dependency.Kind == "blocks" {
			add(dependency.From, dependency.To)
		}
	}
	return blockers
}

func withBlockers(issues []ir.Issue, blockers map[string]map[string]bool) []ir.Issue {
	out := make([]ir.Issue, 0, len(issues))
	for _, issue := range issues {
		issue.DependsOn = sortedKeys(blockers[issue.TempID])
		out = append(out, issue)
	}
	return out
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func indexApprovals(plan ir.Plan) map[string]*ir.Approval {
	index := map[string]*ir.Approval{}
	for position := range plan.Approvals {
		planned := &plan.Approvals[position]
		index[planned.Target.Kind+":"+planned.Target.TempID] = planned
	}
	return index
}

func applyPlannedApprover(params *approvals.CreateParams, planned ir.Approval, now time.Time) {
	if planned.Title != "" {
		params.Title = planned.Title
	}
	if planned.Description != nil {
		params.Description = planned.Description
	}
	switch planned.Approver.Type {
	case automation.ApproverUser:
		if userID, err := uuid.Parse(planned.Approver.UserID); err == nil {
			params.RequestedFromUserID = &userID
		}
	case automation.ApproverRole:
		params.RequestedFromRole = planned.Approver.Role
	}
	if params.RequestedFromUserID == nil && params.RequestedFromRole == "" {
		params.RequestedFromRole = "admin"
	}
	if planned.Timeout != "" {
		if duration, ok := automation.ParseDuration(planned.Timeout); ok {
			expires := now.Add(duration)
			params.ExpiresAt = &expires
		}
	}
}

// compileBoard is the plan's board, or the workspace's oldest one — the board
// every other issue writer uses — and refuses a board from another workspace.
func compileBoard(ctx context.Context, tx pgx.Tx, header PlanHeader) (uuid.UUID, error) {
	var boardID uuid.UUID
	if header.BoardID != nil {
		var workspaceID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT workspace_id FROM boards WHERE id = $1`, *header.BoardID).Scan(&workspaceID); err != nil {
			return uuid.Nil, errors.New("plan board not found")
		}
		if workspaceID != header.WorkspaceID {
			return uuid.Nil, errors.New("plan board belongs to another workspace")
		}
		return *header.BoardID, nil
	}
	err := tx.QueryRow(
		ctx,
		`SELECT id FROM boards WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1`,
		header.WorkspaceID,
	).Scan(&boardID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("workspace has no board for the plan's issues")
	}
	if err != nil {
		return uuid.Nil, errors.New("resolve plan board")
	}
	return boardID, nil
}

// compileAssignee validates a suggested agent belongs to the workspace and is
// live; anything else leaves the issue unassigned rather than failing a plan
// over a stale suggestion.
func compileAssignee(ctx context.Context, tx pgx.Tx, workspaceID uuid.UUID, agentID *uuid.UUID) (*core.AssigneeInput, error) {
	if agentID == nil || *agentID == uuid.Nil {
		return nil, nil
	}
	var exists bool
	if err := tx.QueryRow(
		ctx,
		`SELECT EXISTS (SELECT 1 FROM agents WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL)`,
		*agentID, workspaceID,
	).Scan(&exists); err != nil {
		return nil, errors.New("validate suggested agent")
	}
	if !exists {
		return nil, nil
	}
	return &core.AssigneeInput{Type: "agent", ID: *agentID}, nil
}

type compiledIssue struct {
	ID       uuid.UUID
	BoardID  uuid.UUID
	Issue    ir.Issue
	Status   string
	Assignee *core.AssigneeInput
	ActorID  uuid.UUID
	AutoGate bool
	Now      time.Time
}

func insertCompiledIssue(ctx context.Context, tx pgx.Tx, item compiledIssue) error {
	var number int32
	if err := tx.QueryRow(ctx, `SELECT berry_next_issue_number($1)`, item.BoardID).Scan(&number); err != nil {
		return errors.New("allocate issue number")
	}
	priority := item.Issue.Priority
	if priority == "" {
		priority = "none"
	}
	var (
		assigneeType *string
		assigneeID   *uuid.UUID
	)
	if item.Assignee != nil {
		assigneeType = &item.Assignee.Type
		assigneeID = &item.Assignee.ID
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO issues (
		    id, board_id, number, title, description, status, priority, sort_order,
		    assignee_type, assignee_id, created_by, auto_gate, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6::issue_status, $7::issue_priority, 0, $8::assignee_type, $9, $10, $11, $12, $12)`,
		item.ID, item.BoardID, number, strings.TrimSpace(item.Issue.Title), item.Issue.Description, item.Status, priority,
		assigneeType, assigneeID, item.ActorID, item.AutoGate, item.Now,
	); err != nil {
		return classifyCompileWrite("insert issue", err)
	}
	if item.Assignee != nil {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO assignments (id, issue_id, assignee_type, assignee_id, assigned_by, created_at)
			 VALUES (gen_random_uuid(), $1, $2::assignee_type, $3, $4, $5)`,
			item.ID, item.Assignee.Type, item.Assignee.ID, item.ActorID, item.Now,
		); err != nil {
			return classifyCompileWrite("record assignment", err)
		}
	}
	return nil
}

// attachCapabilityLabels turns requiredCapabilities into issue labels, so
// intake routes the issue by labels ∩ agent capabilities. Labels are matched
// by lower(name) and created when missing.
func attachCapabilityLabels(
	ctx context.Context,
	tx pgx.Tx,
	workspaceID, issueID uuid.UUID,
	capabilities []string,
	actorID uuid.UUID,
	now time.Time,
	newID func() uuid.UUID,
) error {
	seen := map[string]bool{}
	for _, capability := range capabilities {
		name := strings.ToLower(strings.TrimSpace(capability))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		var labelID uuid.UUID
		err := tx.QueryRow(
			ctx,
			`SELECT id FROM issue_labels WHERE workspace_id = $1 AND lower(name) = $2 AND archived_at IS NULL
			  ORDER BY created_at ASC, id ASC LIMIT 1`,
			workspaceID, name,
		).Scan(&labelID)
		if errors.Is(err, pgx.ErrNoRows) {
			labelID = newID()
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO issue_labels (id, workspace_id, name, color, created_by, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
				labelID, workspaceID, name, defaultLabelColor, actorID, now,
			); err != nil {
				return classifyCompileWrite("create label", err)
			}
		} else if err != nil {
			return errors.New("find label")
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO issue_label_memberships (workspace_id, issue_id, label_id, assigned_by, created_at)
			 VALUES ($1, $2, $3, $4, $5)
			 ON CONFLICT (workspace_id, issue_id, label_id) DO NOTHING`,
			workspaceID, issueID, labelID, actorID, now,
		); err != nil {
			return classifyCompileWrite("attach label", err)
		}
	}
	return nil
}

// gateTitle names the gated issue the way a person will see it.
func gateTitle(ctx context.Context, tx pgx.Tx, issueID uuid.UUID, issue ir.Issue) (string, *string) {
	var (
		prefix string
		number int32
	)
	title := "Start " + issue.Title
	if err := tx.QueryRow(
		ctx,
		`SELECT COALESCE(workspace.settings->>'issuePrefix', ''), issue.number
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		   JOIN workspaces AS workspace ON workspace.id = board.workspace_id
		  WHERE issue.id = $1`,
		issueID,
	).Scan(&prefix, &number); err == nil && prefix != "" {
		title = "Start " + issueid.Format(prefix, number) + ": " + issue.Title
	}
	if len(title) > 500 {
		title = title[:497] + "..."
	}
	description := "This issue was planned with an approval before it starts."
	return title, &description
}

// insertApprovalStep compiles a step-targeted planned approval into the
// definition: an approval node takes the target's place in every reference
// and the target waits on it.
func insertApprovalStep(definition automation.Definition, planned ir.Approval) automation.Definition {
	target := planned.Target.StepID
	approvalID := "approve_" + target
	if len(approvalID) > 64 {
		approvalID = approvalID[:64]
	}
	for _, step := range definition.Steps {
		if step.ID == approvalID {
			return definition
		}
	}
	var targetIndex = -1
	for index, step := range definition.Steps {
		if step.ID == target {
			targetIndex = index
		}
	}
	if targetIndex < 0 {
		return definition
	}
	replace := func(ids []string) []string {
		out := make([]string, 0, len(ids))
		for _, id := range ids {
			if id == target {
				id = approvalID
			}
			out = append(out, id)
		}
		return out
	}
	steps := make([]automation.Step, 0, len(definition.Steps)+1)
	for index, step := range definition.Steps {
		if index == targetIndex {
			approval := automation.Step{
				ID: approvalID, Type: automation.StepApproval, DependsOn: append([]string(nil), step.DependsOn...),
				Approval: &automation.ApprovalStep{Title: planned.Title, Approver: planned.Approver, Timeout: planned.Timeout},
			}
			if planned.Description != nil {
				approval.Approval.Description = *planned.Description
			}
			steps = append(steps, approval)
			step.DependsOn = []string{approvalID}
			steps = append(steps, step)
			continue
		}
		step.DependsOn = replace(step.DependsOn)
		switch step.Type {
		case automation.StepCondition:
			if step.Condition != nil {
				condition := *step.Condition
				condition.TrueSteps = replace(condition.TrueSteps)
				condition.FalseSteps = replace(condition.FalseSteps)
				step.Condition = &condition
			}
		case automation.StepSwitch:
			if step.Switch != nil {
				value := *step.Switch
				cases := make([]automation.SwitchCase, 0, len(value.Cases))
				for _, branch := range value.Cases {
					branch.Steps = replace(branch.Steps)
					cases = append(cases, branch)
				}
				value.Cases = cases
				value.DefaultSteps = replace(value.DefaultSteps)
				step.Switch = &value
			}
		case automation.StepForeach:
			if step.Foreach != nil {
				value := *step.Foreach
				value.Steps = replace(value.Steps)
				step.Foreach = &value
			}
		}
		steps = append(steps, step)
	}
	definition.Steps = steps
	definition.Entry = replace(definition.Entry)
	return definition
}

// writePlanEvent records one plan.* fact on the workspace stream.
func writePlanEvent(
	ctx context.Context,
	tx pgx.Tx,
	topic string,
	header PlanHeader,
	detail map[string]any,
	newID func() uuid.UUID,
	occurredAt time.Time,
) (ledger.Event, error) {
	payload := map[string]any{
		"plan": map[string]any{
			"id": header.ID, "workspaceId": header.WorkspaceID, "goalId": header.GoalID,
			"status": header.Status, "compileStatus": header.CompileStatus, "validationStatus": header.ValidationStatus,
		},
	}
	for key, value := range detail {
		payload[key] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ledger.Event{}, errors.New("encode plan event payload")
	}
	return ledger.WriteOutbox(ctx, tx, ledger.OutboxEvent{
		ID:            newID(),
		Topic:         topic,
		AggregateType: "plan",
		AggregateID:   header.ID,
		WorkspaceID:   header.WorkspaceID,
		Payload:       encoded,
		OccurredAt:    occurredAt,
	})
}

func classifyCompileWrite(operation string, err error) error {
	if err == nil {
		return nil
	}
	classified := classifyGeneratedWrite(operation, err)
	if errors.Is(classified, ErrNotFound) || errors.Is(classified, ErrPlanConflict) {
		return classified
	}
	if errors.Is(classified, core.ErrApprovalRequired) {
		return classified
	}
	return fmt.Errorf("%s: %w", operation, err)
}

// safeMessage keeps a compile_error readable without echoing driver detail.
func safeMessage(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrNotFound):
		return "referenced row not found"
	case errors.Is(err, ErrPlanConflict), errors.Is(err, approvals.ErrConflict), errors.Is(err, goals.ErrConflict), errors.Is(err, automationrepo.ErrConflict):
		return "conflicts with existing rows"
	case errors.Is(err, approvals.ErrNotFound), errors.Is(err, goals.ErrNotFound), errors.Is(err, automationrepo.ErrNotFound), errors.Is(err, core.ErrNotFound):
		return "referenced row not found"
	case errors.Is(err, core.ErrDependencyCycle):
		return "dependency cycle"
	case errors.Is(err, core.ErrApprovalRequired):
		return "approval required"
	}
	var transition *goals.TransitionError
	if errors.As(err, &transition) {
		return "goal is " + string(transition.From)
	}
	message := err.Error()
	if index := strings.Index(message, ": "); index > 0 {
		message = message[:index]
	}
	if len(message) > 120 {
		message = message[:120]
	}
	return message
}

func derefUUID(value *uuid.UUID) uuid.UUID {
	if value == nil {
		return uuid.Nil
	}
	return *value
}
