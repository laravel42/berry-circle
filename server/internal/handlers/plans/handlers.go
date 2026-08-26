// Package plans exports the authenticated /api/v1/plans mount for generated
// plans: reading a plan and its history, validating it, and the approve →
// compile step that turns it into rows. Generation itself arrives with the
// planner.
package plans

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/handlers/automations"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/planner/ir"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	planrepo "github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Authorizer is the narrow plan boundary.
type Authorizer interface {
	AuthorizePlan(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
}

// Store is the generated-plan persistence these routes call.
type Store interface {
	GetHeader(context.Context, uuid.UUID) (planrepo.PlanHeader, error)
	ListVersions(context.Context, uuid.UUID) ([]planrepo.PlanVersion, error)
	ListEvents(context.Context, uuid.UUID) ([]planrepo.PlannerEvent, error)
	SetValidation(context.Context, uuid.UUID, string, time.Time) error
	Compile(context.Context, planrepo.CompileParams) (planrepo.CompileResult, error)
	RejectGenerated(context.Context, uuid.UUID, string, time.Time) error
	RequestPlanApproval(context.Context, planrepo.RequestPlanApprovalParams) (planrepo.PlanHeader, approvalrepo.Approval, ledger.Event, error)
}

// GoalStore is what rejecting a plan needs: to archive the draft goal a
// generated plan created and nothing else uses.
type GoalStore interface {
	Get(context.Context, uuid.UUID) (goalrepo.Goal, error)
	ListIssues(context.Context, uuid.UUID, int) ([]goalrepo.LinkedIssue, error)
	Archive(context.Context, uuid.UUID, uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Event, error)
}

// ApprovalStore is what post-compile activation needs to ask an admin.
type ApprovalStore interface {
	List(context.Context, uuid.UUID, approvalrepo.ListFilter, *approvalrepo.Cursor, int) ([]approvalrepo.Approval, error)
	Create(context.Context, approvalrepo.CreateParams) (approvalrepo.Approval, approvalrepo.Event, error)
}

// Options are explicit process dependencies.
type Options struct {
	Pool             *pgxpool.Pool
	Store            Store
	Goals            GoalStore
	Automations      automations.Store
	Approvals        ApprovalStore
	Registry         *integrationcore.Registry
	Connections      automations.ConnectionReader
	Engine           automation.Engine
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
}

type handler struct {
	options Options
}

// NewMount validates dependencies and builds the plans subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("plan handler session resolver is nil")
	case options.Authorization == nil:
		return httpapi.Mount{}, errors.New("plan handler authorizer is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("plan handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("plan handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return httpapi.Mount{}, errors.New("plan handler idempotency store is nil")
	}
	if options.Store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("plan handler pool is nil")
		}
		store, err := planrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Store = store
	}
	if options.Goals == nil && options.Pool != nil {
		store, err := goalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Goals = store
	}
	if options.Automations == nil && options.Pool != nil {
		store, err := automationrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Automations = store
	}
	if options.Approvals == nil && options.Pool != nil {
		store, err := approvalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Approvals = store
	}
	if options.Engine == nil {
		options.Engine = automation.NoopEngine{}
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/{planId}", target.get)
	router.Get("/{planId}/versions", target.listVersions)
	router.Get("/{planId}/events", target.listEvents)
	router.Post("/{planId}/validate", target.validate)
	router.Post("/{planId}/approve", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.approve)).ServeHTTP)
	router.Post("/{planId}/compile", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.compile)).ServeHTTP)
	router.Post("/{planId}/reject", target.reject)
	return httpapi.Mount{Prefix: "/api/v1/plans", Handler: router}, nil
}

type generationResource struct {
	Status string  `json:"status"`
	Error  *string `json:"error"`
	Stage  *string `json:"stage"`
}

type requiredConnectionResource struct {
	Provider  string `json:"provider"`
	Purpose   string `json:"purpose"`
	Connected bool   `json:"connected"`
}

type validationResource struct {
	Status               string                       `json:"status"`
	Errors               []ir.Finding                 `json:"errors"`
	Warnings             []ir.Finding                 `json:"warnings"`
	RequiredConnections  []requiredConnectionResource `json:"requiredConnections"`
	Ambiguities          []any                        `json:"ambiguities"`
	Risk                 string                       `json:"risk"`
	NeedsAdminActivation bool                         `json:"needsAdminActivation"`
}

type compileResource struct {
	Status      string      `json:"status"`
	Error       *string     `json:"error"`
	CompiledAt  *string     `json:"compiledAt"`
	GoalID      *uuid.UUID  `json:"goalId"`
	IssueIDs    []uuid.UUID `json:"issueIds"`
	WorkflowIDs []uuid.UUID `json:"workflowIds"`
	ApprovalIDs []uuid.UUID `json:"approvalIds"`
}

type resource struct {
	ID             uuid.UUID          `json:"id"`
	WorkspaceID    uuid.UUID          `json:"workspaceId"`
	GoalID         *uuid.UUID         `json:"goalId"`
	ProjectID      *uuid.UUID         `json:"projectId"`
	Status         string             `json:"status"`
	Source         string             `json:"source"`
	SourcePrompt   *string            `json:"sourcePrompt"`
	IRVersion      *string            `json:"irVersion"`
	Version        int                `json:"version"`
	PlannerVersion *string            `json:"plannerVersion"`
	Confidence     *float64           `json:"confidence"`
	Generation     generationResource `json:"generation"`
	Validation     validationResource `json:"validation"`
	Critic         *json.RawMessage   `json:"critic"`
	Compile        *compileResource   `json:"compile"`
	Plan           json.RawMessage    `json:"plan"`
	CreatedAt      string             `json:"createdAt"`
	UpdatedAt      string             `json:"updatedAt"`
}

func wireStatus(status string) string {
	if status == planrepo.StatusPendingApproval {
		return "pendingApproval"
	}
	return status
}

func (handler *handler) catalog(ctx context.Context, workspaceID uuid.UUID) automation.Catalog {
	return automations.CatalogFor(ctx, handler.options.Registry, handler.options.Connections, workspaceID)
}

// serialize builds the plan resource. Validation findings and risk are
// computed from the stored IR on every read: they are cheap, deterministic,
// and the only way a plan whose catalog changed shows the change.
func (handler *handler) serialize(ctx context.Context, header planrepo.PlanHeader, role identity.Role) resource {
	out := resource{
		ID: header.ID, WorkspaceID: header.WorkspaceID, GoalID: header.GoalID, ProjectID: header.ProjectID, Status: wireStatus(header.Status),
		Source: string(header.Source), SourcePrompt: header.SourcePrompt, IRVersion: header.IRVersion, Version: header.CurrentVersion,
		PlannerVersion: header.PlannerVersion, Confidence: header.Confidence,
		Generation: generationResource{Status: header.GenerationStatus, Error: header.GenerationError},
		Validation: validationResource{Status: header.ValidationStatus, Errors: []ir.Finding{}, Warnings: []ir.Finding{},
			RequiredConnections: []requiredConnectionResource{}, Ambiguities: []any{}, Risk: string(automation.RiskLow)},
		Plan:      json.RawMessage(`null`),
		CreatedAt: header.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: header.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if header.CompileStatus != planrepo.CompileNotStarted {
		out.Compile = &compileResource{Status: header.CompileStatus, Error: header.CompileError, GoalID: header.GoalID,
			IssueIDs: []uuid.UUID{}, WorkflowIDs: []uuid.UUID{}, ApprovalIDs: []uuid.UUID{}}
		if header.CompiledAt != nil {
			value := header.CompiledAt.UTC().Format(time.RFC3339Nano)
			out.Compile.CompiledAt = &value
		}
	}
	if len(header.IR) == 0 {
		return out
	}
	out.Plan = header.IR
	plan, err := ir.Parse(header.IR)
	if err != nil {
		out.Validation.Errors = append(out.Validation.Errors, ir.Finding{Path: "", Code: "PLAN_INVALID_JSON", Message: err.Error(), Severity: automation.SeverityError})
		return out
	}
	catalog := handler.catalog(ctx, header.WorkspaceID)
	for _, finding := range planrepo.Validate(plan, catalog) {
		if finding.Severity == automation.SeverityWarning {
			out.Validation.Warnings = append(out.Validation.Warnings, finding)
		} else {
			out.Validation.Errors = append(out.Validation.Errors, finding)
		}
	}
	for _, connection := range plan.RequiredConnections {
		out.Validation.RequiredConnections = append(out.Validation.RequiredConnections, requiredConnectionResource{
			Provider: connection.Provider, Purpose: connection.Purpose, Connected: catalog != nil && catalog.Connected(connection.Provider),
		})
	}
	risk := planrepo.PlanRisk(plan, catalog)
	out.Validation.Risk = string(risk)
	out.Validation.NeedsAdminActivation = risk == automation.RiskHigh && !role.Allows(identity.PermissionSettingsWrite)
	if plan.Compiled != nil && out.Compile != nil {
		out.Compile.IssueIDs = sortedValues(plan.Compiled.IssueIDs)
		out.Compile.WorkflowIDs = sortedValues(plan.Compiled.WorkflowIDs)
		out.Compile.ApprovalIDs = sortedValues(plan.Compiled.ApprovalIDs)
	}
	return out
}

func sortedValues(values map[string]uuid.UUID) []uuid.UUID {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sortStrings(keys)
	out := make([]uuid.UUID, 0, len(keys))
	for _, key := range keys {
		out = append(out, values[key])
	}
	return out
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}

// authorize resolves the plan in the path. A viewer asking to change a plan
// is told PLAN_FORBIDDEN, the planner's own refusal code.
func (handler *handler) authorize(response http.ResponseWriter, request *http.Request, permission identity.Permission) (planrepo.PlanHeader, identity.Scope, bool) {
	planID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "planId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Plan")
		return planrepo.PlanHeader{}, identity.Scope{}, false
	}
	user := auth.MustUser(request.Context())
	scope, err := handler.options.Authorization.AuthorizePlan(request.Context(), user.ID, planID, permission)
	if errors.Is(err, identity.ErrForbidden) && permission != identity.PermissionRead {
		httpapi.WriteError(response, request, http.StatusForbidden, "PLAN_FORBIDDEN", "Viewers cannot change plans.", nil)
		return planrepo.PlanHeader{}, identity.Scope{}, false
	}
	if !workmanagement.WriteAuthorization(response, request, err, "Plan") {
		return planrepo.PlanHeader{}, identity.Scope{}, false
	}
	header, err := handler.options.Store.GetHeader(request.Context(), planID)
	if err != nil {
		handler.writeError(response, request, err)
		return planrepo.PlanHeader{}, identity.Scope{}, false
	}
	if header.Source == planrepo.SourceOrchestrator {
		// Orchestrator briefs are served by the project routes; they have no IR.
		workmanagement.WriteNotFound(response, request, "Plan")
		return planrepo.PlanHeader{}, identity.Scope{}, false
	}
	return header, scope, true
}

func (handler *handler) get(response http.ResponseWriter, request *http.Request) {
	header, scope, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), header, scope.Role))
}

type versionResource struct {
	ID         uuid.UUID       `json:"id"`
	Version    int             `json:"version"`
	Origin     string          `json:"origin"`
	Plan       json.RawMessage `json:"plan"`
	Validation json.RawMessage `json:"validation"`
	Critic     json.RawMessage `json:"critic"`
	Patch      json.RawMessage `json:"patch"`
	CreatedBy  *uuid.UUID      `json:"createdBy"`
	CreatedAt  string          `json:"createdAt"`
}

func (handler *handler) listVersions(response http.ResponseWriter, request *http.Request) {
	header, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	versions, err := handler.options.Store.ListVersions(request.Context(), header.ID)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]versionResource, 0, len(versions))
	for _, version := range versions {
		nodes = append(nodes, versionResource{
			ID: version.ID, Version: version.Version, Origin: version.Origin, Plan: version.IR, Validation: nullableJSON(version.Validation),
			Critic: nullableJSON(version.Critic), Patch: nullableJSON(version.Patch), CreatedBy: version.CreatedBy,
			CreatedAt: version.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

type eventResource struct {
	ID            uuid.UUID       `json:"id"`
	Sequence      int             `json:"sequence"`
	Stage         string          `json:"stage"`
	Role          *string         `json:"role"`
	PromptVersion *string         `json:"promptVersion"`
	ModelProvider *string         `json:"modelProvider"`
	ModelName     *string         `json:"modelName"`
	InputTokens   *int64          `json:"inputTokens"`
	OutputTokens  *int64          `json:"outputTokens"`
	CostMicros    *int64          `json:"costMicros"`
	DurationMS    *int64          `json:"durationMs"`
	Outcome       string          `json:"outcome"`
	Detail        json.RawMessage `json:"detail"`
	OccurredAt    string          `json:"occurredAt"`
}

func (handler *handler) listEvents(response http.ResponseWriter, request *http.Request) {
	header, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	events, err := handler.options.Store.ListEvents(request.Context(), header.ID)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]eventResource, 0, len(events))
	for _, event := range events {
		nodes = append(nodes, eventResource{
			ID: event.ID, Sequence: event.Sequence, Stage: event.Stage, Role: event.Role, PromptVersion: event.PromptVersion,
			ModelProvider: event.ModelProvider, ModelName: event.ModelName, InputTokens: event.InputTokens, OutputTokens: event.OutputTokens,
			CostMicros: event.CostMicros, DurationMS: event.DurationMS, Outcome: event.Outcome, Detail: nullableJSON(event.Detail),
			OccurredAt: event.OccurredAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

// validate re-runs the deterministic checks and records the verdict.
func (handler *handler) validate(response http.ResponseWriter, request *http.Request) {
	header, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	status := planrepo.ValidationUnknown
	if len(header.IR) > 0 {
		status = planrepo.ValidationInvalid
		if plan, err := ir.Parse(header.IR); err == nil && ir.Valid(planrepo.Validate(plan, handler.catalog(request.Context(), header.WorkspaceID))) {
			status = planrepo.ValidationValid
		}
	}
	if err := handler.options.Store.SetValidation(request.Context(), header.ID, status, handler.options.Clock().UTC()); err != nil {
		handler.writeError(response, request, err)
		return
	}
	header, err := handler.options.Store.GetHeader(request.Context(), header.ID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), header, scope.Role))
}

type noteBody struct {
	Note workmanagement.Optional[string] `json:"note"`
}

func parseNote(response http.ResponseWriter, request *http.Request) (string, bool) {
	body, _, ok := workmanagement.DecodeJSON[noteBody](response, request)
	if !ok {
		return "", false
	}
	note := ""
	if body.Note.Set && !body.Note.Null {
		note = strings.TrimSpace(body.Note.Value)
		if utf8.RuneCountInString(note) > 5000 {
			workmanagement.WriteValidation(response, request, httpapi.FieldError{Path: "/note", Code: "too_big", Message: "note must contain at most 5000 characters."})
			return "", false
		}
	}
	return note, true
}

// approve is Start Plan. A member approving a high-risk plan does not compile
// it: the plan goes to pending approval with a request addressed to admins,
// so the button never silently fails. Everyone else compiles in place.
func (handler *handler) approve(response http.ResponseWriter, request *http.Request) {
	header, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	note, ok := parseNote(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	now := handler.options.Clock().UTC()
	if len(header.IR) > 0 && header.Status == planrepo.StatusDraft {
		if plan, err := ir.Parse(header.IR); err == nil {
			risk := planrepo.PlanRisk(plan, handler.catalog(request.Context(), header.WorkspaceID))
			if risk == automation.RiskHigh && !scope.Role.Allows(identity.PermissionSettingsWrite) {
				title := "Start plan: " + plan.Goal.Title
				var description *string
				if note != "" {
					description = &note
				}
				pending, _, event, err := handler.options.Store.RequestPlanApproval(request.Context(), planrepo.RequestPlanApprovalParams{
					PlanID: header.ID, ActorID: user.ID, Title: title, Description: description, Risk: approvalrepo.RiskHigh,
					RequestedFromRole: string(identity.RoleAdmin), Now: now, NewID: handler.options.NewID,
				})
				if err != nil {
					handler.writeError(response, request, err)
					return
				}
				shared.PublishLedger(request.Context(), handler.options.Broadcaster, []ledger.Event{event})
				httpapi.WriteJSON(response, http.StatusAccepted, handler.serialize(request.Context(), pending, scope.Role))
				return
			}
		}
	}
	if header.Status == planrepo.StatusPendingApproval && !scope.Role.Allows(identity.PermissionSettingsWrite) {
		// Already waiting on an admin; pressing Start again changes nothing.
		httpapi.WriteJSON(response, http.StatusAccepted, handler.serialize(request.Context(), header, scope.Role))
		return
	}
	handler.runCompile(response, request, header, scope, user.ID, now)
}

// compile retries a compile that failed after approval.
func (handler *handler) compile(response http.ResponseWriter, request *http.Request) {
	header, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	handler.runCompile(response, request, header, scope, user.ID, handler.options.Clock().UTC())
}

func (handler *handler) runCompile(response http.ResponseWriter, request *http.Request, header planrepo.PlanHeader, scope identity.Scope, actorID uuid.UUID, now time.Time) {
	catalog := handler.catalog(request.Context(), header.WorkspaceID)
	result, err := handler.options.Store.Compile(request.Context(), planrepo.CompileParams{
		PlanID: header.ID, ActorID: actorID, Now: now, NewID: handler.options.NewID, Catalog: catalog,
	})
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	if !result.AlreadyCompiled {
		shared.PublishLedger(request.Context(), handler.options.Broadcaster, result.Events)
		shared.PublishIssue(request.Context(), handler.options.Broadcaster, result.IssueEvents)
		handler.activateAfterCompile(request.Context(), result, scope, actorID, now.Add(time.Second))
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), result.Plan, scope.Role))
}

// activateAfterCompile honours activateOnApprove after the compile committed:
// the actor's own activation rule applies, and when it refuses for lack of
// rank an admin is asked instead. A refusal for any other reason leaves the
// draft where a person can see why.
func (handler *handler) activateAfterCompile(ctx context.Context, result planrepo.CompileResult, scope identity.Scope, actorID uuid.UUID, now time.Time) {
	if handler.options.Automations == nil {
		return
	}
	catalog := handler.catalog(ctx, result.Plan.WorkspaceID)
	for _, automationID := range result.ActivateOnApprove {
		item, err := handler.options.Automations.Get(ctx, automationID)
		if err != nil {
			continue
		}
		if handler.hasPendingActivation(ctx, item) {
			continue
		}
		_, events, err := automations.Activate(ctx, handler.options.Automations, automations.ActivationParams{
			Automation: item, Role: scope.Role, ActorID: actorID, Catalog: catalog, Engine: handler.options.Engine, Now: now, NewID: handler.options.NewID,
		})
		if err == nil {
			shared.PublishLedger(ctx, handler.options.Broadcaster, events)
			continue
		}
		if errors.Is(err, automations.ErrHighRisk) && handler.options.Approvals != nil {
			_, event, err := handler.options.Approvals.Create(ctx, approvalrepo.CreateParams{
				ID: handler.options.NewID(), WorkspaceID: item.WorkspaceID, Kind: approvalrepo.KindAutomationActivation, Risk: approvalrepo.RiskHigh,
				Title: "Activate " + item.Name, GoalID: item.GoalID, AutomationID: &item.ID, RequestedFromRole: string(identity.RoleAdmin),
				RequestedByType: approvalrepo.ActorUser, RequestedBy: &actorID, RequestedAt: now, NewID: handler.options.NewID,
			})
			if err == nil {
				shared.PublishLedger(ctx, handler.options.Broadcaster, []ledger.Event{event})
			}
		}
	}
}

func (handler *handler) hasPendingActivation(ctx context.Context, item automationrepo.Automation) bool {
	if handler.options.Approvals == nil {
		return false
	}
	found, err := handler.options.Approvals.List(ctx, item.WorkspaceID, approvalrepo.ListFilter{
		Status: approvalrepo.StatusPending, Kind: approvalrepo.KindAutomationActivation, AutomationID: &item.ID,
	}, nil, 1)
	return err == nil && len(found) > 0
}

// reject closes an open plan. The draft goal a generated plan created for
// itself is archived with it when nothing else uses the goal yet.
func (handler *handler) reject(response http.ResponseWriter, request *http.Request) {
	header, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	note, ok := parseNote(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	now := handler.options.Clock().UTC()
	if err := handler.options.Store.RejectGenerated(request.Context(), header.ID, note, now); err != nil {
		handler.writeError(response, request, err)
		return
	}
	if header.GoalID != nil && handler.options.Goals != nil {
		if goal, err := handler.options.Goals.Get(request.Context(), *header.GoalID); err == nil &&
			goal.Source == goalrepo.SourceAI && goal.Status == goalrepo.StatusDraft {
			if issues, err := handler.options.Goals.ListIssues(request.Context(), goal.ID, 1); err == nil && len(issues) == 0 {
				if event, err := handler.options.Goals.Archive(request.Context(), goal.ID, user.ID, now, handler.options.NewID); err == nil {
					shared.PublishLedger(request.Context(), handler.options.Broadcaster, []ledger.Event{event})
				}
			}
		}
	}
	rejected, err := handler.options.Store.GetHeader(request.Context(), header.ID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), rejected, scope.Role))
}

func (handler *handler) writeError(response http.ResponseWriter, request *http.Request, err error) {
	var invalid *planrepo.InvalidPlanError
	var failure *planrepo.CompileError
	switch {
	case errors.As(err, &invalid):
		httpapi.WriteError(response, request, http.StatusConflict, "PLAN_INVALID", "The plan does not pass validation and cannot be compiled.",
			map[string]any{"fields": invalid.Findings})
	case errors.Is(err, planrepo.ErrPlanInvalid):
		httpapi.WriteError(response, request, http.StatusConflict, "PLAN_INVALID", "The plan is not valid.", nil)
	case errors.As(err, &failure):
		httpapi.WriteError(response, request, http.StatusConflict, "PLAN_COMPILE_FAILED", "The plan was approved but could not be compiled; retry with POST /compile.",
			map[string]string{"stage": failure.Stage, "message": failure.Message})
	case errors.Is(err, planrepo.ErrCompileInProgress):
		httpapi.WriteError(response, request, http.StatusConflict, "PLAN_BUSY", "The plan is being compiled.", nil)
	case errors.Is(err, planrepo.ErrNotOpen):
		httpapi.WriteError(response, request, http.StatusConflict, "PLAN_NOT_OPEN", "The plan is no longer open.", nil)
	case errors.Is(err, planrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, "Plan")
	case errors.Is(err, planrepo.ErrPlanConflict), errors.Is(err, approvalrepo.ErrConflict):
		httpapi.WriteError(response, request, http.StatusConflict, "CONFLICT", "The plan could not be written because its state conflicts.", nil)
	default:
		workmanagement.WriteInternal(response, request)
	}
}

func nullableJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`null`)
	}
	return raw
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic("construct plan handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
