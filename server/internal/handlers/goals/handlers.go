// Package goals exports the authenticated /api/v1/goals mount: the outcome a
// person asked for, what serves it, and how far along it is.
package goals

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Authorizer is the narrow workspace/goal/issue boundary these routes need.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
	AuthorizeGoal(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
	AuthorizeIssueReference(context.Context, uuid.UUID, string, identity.Permission) (identity.Scope, error)
}

// Store is the goal persistence these routes call.
type Store interface {
	List(context.Context, uuid.UUID, goalrepo.ListFilter, *goalrepo.Cursor, int) ([]goalrepo.Goal, error)
	Get(context.Context, uuid.UUID) (goalrepo.Goal, error)
	Create(context.Context, goalrepo.CreateParams) (goalrepo.Goal, goalrepo.Event, error)
	Update(context.Context, uuid.UUID, goalrepo.Patch, uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Goal, goalrepo.Event, error)
	Transition(context.Context, uuid.UUID, goalrepo.Status, *uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Goal, goalrepo.Event, error)
	Archive(context.Context, uuid.UUID, uuid.UUID, time.Time, func() uuid.UUID) (goalrepo.Event, error)
	LinkIssue(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, uuid.UUID, time.Time) error
	UnlinkIssue(context.Context, uuid.UUID, uuid.UUID) error
	ListIssues(context.Context, uuid.UUID, int) ([]goalrepo.LinkedIssue, error)
	Progress(context.Context, uuid.UUID) (goalrepo.Progress, error)
}

// IssueResolver turns an issue reference into an issue id.
type IssueResolver interface {
	GetIssue(context.Context, string) (core.Issue, error)
}

// Options are explicit process dependencies.
type Options struct {
	Pool             *pgxpool.Pool
	Store            Store
	Issues           IssueResolver
	Automations      *automationrepo.Repository
	Approvals        *approvals.Repository
	Plans            *plans.Repository
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

// NewMount validates dependencies and builds the goals subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("goal handler session resolver is nil")
	case options.Authorization == nil:
		return httpapi.Mount{}, errors.New("goal handler authorizer is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("goal handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("goal handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return httpapi.Mount{}, errors.New("goal handler idempotency store is nil")
	}
	if options.Store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("goal handler pool is nil")
		}
		store, err := goalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Store = store
	}
	if options.Issues == nil && options.Pool != nil {
		issues, err := core.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Issues = issues
	}
	if options.Automations == nil && options.Pool != nil {
		automations, err := automationrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Automations = automations
	}
	if options.Approvals == nil && options.Pool != nil {
		approvalStore, err := approvals.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Approvals = approvalStore
	}
	if options.Plans == nil && options.Pool != nil {
		planStore, err := plans.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Plans = planStore
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.list)
	router.Post("/", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.create)).ServeHTTP)
	router.Get("/{goalId}", target.get)
	router.Patch("/{goalId}", target.update)
	router.Delete("/{goalId}", target.archive)
	router.Get("/{goalId}/issues", target.listIssues)
	router.Put("/{goalId}/issues/{issueRef}", target.linkIssue)
	router.Delete("/{goalId}/issues/{issueRef}", target.unlinkIssue)
	router.Get("/{goalId}/workflows", target.listWorkflows)
	router.Get("/{goalId}/approvals", target.listApprovals)
	router.Get("/{goalId}/plans", target.listPlans)
	return httpapi.Mount{Prefix: "/api/v1/goals", Handler: router}, nil
}

type progressResource struct {
	IssuesTotal      int `json:"issuesTotal"`
	IssuesDone       int `json:"issuesDone"`
	IssuesCancelled  int `json:"issuesCancelled"`
	WorkflowsActive  int `json:"workflowsActive"`
	ApprovalsPending int `json:"approvalsPending"`
}

type goalResource struct {
	ID           uuid.UUID         `json:"id"`
	WorkspaceID  uuid.UUID         `json:"workspaceId"`
	ProjectID    *uuid.UUID        `json:"projectId"`
	Title        string            `json:"title"`
	Description  *string           `json:"description"`
	Status       string            `json:"status"`
	Source       string            `json:"source"`
	SourcePrompt *string           `json:"sourcePrompt"`
	CreatedBy    *core.ActorRef    `json:"createdBy"`
	CreatedAt    string            `json:"createdAt"`
	UpdatedAt    string            `json:"updatedAt"`
	StartedAt    *string           `json:"startedAt"`
	CompletedAt  *string           `json:"completedAt"`
	Progress     *progressResource `json:"progress,omitempty"`
}

type connection[T any] struct {
	Nodes    []T                     `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

func (handler *handler) serialize(ctx context.Context, goal goalrepo.Goal, progress *goalrepo.Progress) goalResource {
	resource := goalResource{
		ID: goal.ID, WorkspaceID: goal.WorkspaceID, ProjectID: goal.ProjectID, Title: goal.Title, Description: goal.Description,
		Status: string(goal.Status), Source: string(goal.Source), SourcePrompt: goal.SourcePrompt,
		CreatedAt: goal.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: goal.UpdatedAt.UTC().Format(time.RFC3339Nano),
		StartedAt: formatTime(goal.StartedAt), CompletedAt: formatTime(goal.CompletedAt),
	}
	if goal.CreatedBy != nil {
		resource.CreatedBy = &core.ActorRef{Type: "user", ID: *goal.CreatedBy, Name: "Unknown user"}
		if handler.options.Pool != nil {
			if users, err := core.LookupUsers(ctx, handler.options.Pool, []uuid.UUID{*goal.CreatedBy}); err == nil {
				if ref, ok := users[*goal.CreatedBy]; ok {
					resource.CreatedBy = &ref
				}
			}
		}
	}
	if progress != nil {
		resource.Progress = &progressResource{
			IssuesTotal: progress.IssuesTotal, IssuesDone: progress.IssuesDone, IssuesCancelled: progress.IssuesCancelled,
			WorkflowsActive: progress.AutomationsActive, ApprovalsPending: progress.ApprovalsPending,
		}
	}
	return resource
}

func (handler *handler) list(response http.ResponseWriter, request *http.Request) {
	page, ok := workmanagement.ParsePage(response, request, "workspaceId", "query", "status", "projectId")
	if !ok {
		return
	}
	query := request.URL.Query()
	workspaceID, ok := workmanagement.ParseCanonicalUUID(query.Get("workspaceId"))
	if !ok {
		workmanagement.WriteInvalidQuery(response, request, "/query/workspaceId", "workspaceId must be a canonical UUID.")
		return
	}
	filter := goalrepo.ListFilter{Query: strings.TrimSpace(query.Get("query"))}
	if status := query.Get("status"); status != "" {
		if !goalrepo.Status(status).Valid() {
			workmanagement.WriteInvalidQuery(response, request, "/query/status", "status is not a goal status.")
			return
		}
		filter.Status = goalrepo.Status(status)
	}
	if raw := query.Get("projectId"); raw != "" {
		projectID, ok := workmanagement.ParseCanonicalUUID(raw)
		if !ok {
			workmanagement.WriteInvalidQuery(response, request, "/query/projectId", "projectId must be a canonical UUID.")
			return
		}
		filter.ProjectID = &projectID
	}
	if utf8.RuneCountInString(filter.Query) > 200 {
		workmanagement.WriteInvalidQuery(response, request, "/query/query", "query is at most 200 characters.")
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionRead); !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	scope := workmanagement.CursorScope("goals.list", workspaceID.String(), filter.Query, string(filter.Status), query.Get("projectId"))
	var after *goalrepo.Cursor
	if page.After != "" {
		var cursor goalrepo.Cursor
		if httpapi.DecodeCursor(page.After, scope, &cursor) != nil || cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	goals, err := handler.options.Store.List(request.Context(), workspaceID, filter, after, page.First+1)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	hasNext := len(goals) > page.First
	if hasNext {
		goals = goals[:page.First]
	}
	nodes := make([]goalResource, 0, len(goals))
	for _, goal := range goals {
		nodes = append(nodes, handler.serialize(request.Context(), goal, nil))
	}
	var endCursor *string
	if len(goals) > 0 {
		last := goals[len(goals)-1]
		encoded, err := httpapi.EncodeCursor(scope, goalrepo.Cursor{UpdatedAt: last.UpdatedAt, ID: last.ID})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, connection[goalResource]{Nodes: nodes, PageInfo: workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: endCursor}})
}

type createBody struct {
	WorkspaceID string                          `json:"workspaceId"`
	Title       string                          `json:"title"`
	Description workmanagement.Optional[string] `json:"description"`
	ProjectID   workmanagement.Optional[string] `json:"projectId"`
}

func (handler *handler) create(response http.ResponseWriter, request *http.Request) {
	body, _, ok := workmanagement.DecodeJSON[createBody](response, request)
	if !ok {
		return
	}
	var fields []httpapi.FieldError
	workspaceID, valid := workmanagement.ParseCanonicalUUID(body.WorkspaceID)
	if !valid {
		fields = append(fields, httpapi.FieldError{Path: "/workspaceId", Code: "invalid", Message: "workspaceId must be a canonical UUID."})
	}
	title := strings.TrimSpace(body.Title)
	if length := utf8.RuneCountInString(title); length < 1 || length > 500 {
		fields = append(fields, httpapi.FieldError{Path: "/title", Code: "invalid", Message: "title must contain 1 to 500 characters."})
	}
	var description *string
	if body.Description.Set && !body.Description.Null {
		if utf8.RuneCountInString(body.Description.Value) > 20000 {
			fields = append(fields, httpapi.FieldError{Path: "/description", Code: "too_big", Message: "description must contain at most 20000 characters."})
		}
		description = &body.Description.Value
	}
	var projectID *uuid.UUID
	if body.ProjectID.Set && !body.ProjectID.Null {
		parsed, ok := workmanagement.ParseCanonicalUUID(body.ProjectID.Value)
		if !ok {
			fields = append(fields, httpapi.FieldError{Path: "/projectId", Code: "invalid", Message: "projectId must be a canonical UUID."})
		} else {
			projectID = &parsed
		}
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionWrite); !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	goal, event, err := handler.options.Store.Create(request.Context(), goalrepo.CreateParams{
		ID: handler.options.NewID(), WorkspaceID: workspaceID, ProjectID: projectID, Title: title, Description: description,
		Status: goalrepo.StatusDraft, Source: goalrepo.SourceManual, CreatedBy: user.ID, CreatedAt: handler.options.Clock().UTC(),
		NewID: handler.options.NewID,
	})
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []goalrepo.Event{event})
	response.Header().Set("Location", "/api/v1/goals/"+goal.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, handler.serialize(request.Context(), goal, &goalrepo.Progress{}))
}

// authorize resolves the goal in the path and checks one permission. The
// scope is the goal's workspace; a goal elsewhere reads as not found.
func (handler *handler) authorize(response http.ResponseWriter, request *http.Request, permission identity.Permission) (uuid.UUID, identity.Scope, bool) {
	goalID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "goalId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Goal")
		return uuid.Nil, identity.Scope{}, false
	}
	user := auth.MustUser(request.Context())
	scope, err := handler.options.Authorization.AuthorizeGoal(request.Context(), user.ID, goalID, permission)
	if !workmanagement.WriteAuthorization(response, request, err, "Goal") {
		return uuid.Nil, identity.Scope{}, false
	}
	return goalID, scope, true
}

func (handler *handler) get(response http.ResponseWriter, request *http.Request) {
	goalID, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	goal, err := handler.options.Store.Get(request.Context(), goalID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	progress, err := handler.options.Store.Progress(request.Context(), goalID)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), goal, &progress))
}

type updateBody struct {
	Title       workmanagement.Optional[string] `json:"title"`
	Description workmanagement.Optional[string] `json:"description"`
	Status      workmanagement.Optional[string] `json:"status"`
	ProjectID   workmanagement.Optional[string] `json:"projectId"`
}

func (handler *handler) update(response http.ResponseWriter, request *http.Request) {
	goalID, _, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	body, _, ok := workmanagement.DecodeJSON[updateBody](response, request)
	if !ok {
		return
	}
	var (
		fields []httpapi.FieldError
		patch  goalrepo.Patch
		status goalrepo.Status
	)
	if body.Title.Set {
		if body.Title.Null {
			fields = append(fields, httpapi.FieldError{Path: "/title", Code: "invalid_type", Message: "title cannot be null."})
		} else {
			title := strings.TrimSpace(body.Title.Value)
			if length := utf8.RuneCountInString(title); length < 1 || length > 500 {
				fields = append(fields, httpapi.FieldError{Path: "/title", Code: "invalid", Message: "title must contain 1 to 500 characters."})
			}
			patch.Title = &title
		}
	}
	if body.Description.Set {
		patch.DescriptionSet = true
		if !body.Description.Null {
			if utf8.RuneCountInString(body.Description.Value) > 20000 {
				fields = append(fields, httpapi.FieldError{Path: "/description", Code: "too_big", Message: "description must contain at most 20000 characters."})
			}
			patch.Description = &body.Description.Value
		}
	}
	if body.ProjectID.Set {
		patch.ProjectSet = true
		if !body.ProjectID.Null {
			parsed, ok := workmanagement.ParseCanonicalUUID(body.ProjectID.Value)
			if !ok {
				fields = append(fields, httpapi.FieldError{Path: "/projectId", Code: "invalid", Message: "projectId must be a canonical UUID."})
			} else {
				patch.ProjectID = &parsed
			}
		}
	}
	if body.Status.Set {
		if body.Status.Null || !goalrepo.Status(body.Status.Value).Valid() || goalrepo.Status(body.Status.Value) == goalrepo.StatusBlocked {
			fields = append(fields, httpapi.FieldError{Path: "/status", Code: "invalid_enum_value",
				Message: "status is draft, planned, active, completed or cancelled."})
		} else {
			status = goalrepo.Status(body.Status.Value)
		}
	}
	if patch.Empty() && status == "" && len(fields) == 0 {
		fields = append(fields, httpapi.FieldError{Path: "/", Code: "too_small", Message: "At least one field must be provided."})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return
	}
	user := auth.MustUser(request.Context())
	now := handler.options.Clock().UTC()
	var (
		goal   goalrepo.Goal
		events []goalrepo.Event
		err    error
	)
	if !patch.Empty() {
		var event goalrepo.Event
		goal, event, err = handler.options.Store.Update(request.Context(), goalID, patch, user.ID, now, handler.options.NewID)
		if err != nil {
			handler.writeError(response, request, err)
			return
		}
		events = append(events, event)
	}
	if status != "" {
		var event goalrepo.Event
		goal, event, err = handler.options.Store.Transition(request.Context(), goalID, status, &user.ID, now.Add(time.Microsecond), handler.options.NewID)
		if err != nil {
			handler.writeError(response, request, err)
			return
		}
		if event.ID != uuid.Nil {
			events = append(events, event)
		}
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, events)
	progress, err := handler.options.Store.Progress(request.Context(), goalID)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), goal, &progress))
}

func (handler *handler) archive(response http.ResponseWriter, request *http.Request) {
	goalID, _, ok := handler.authorize(response, request, identity.PermissionSettingsWrite)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	event, err := handler.options.Store.Archive(request.Context(), goalID, user.ID, handler.options.Clock().UTC(), handler.options.NewID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []goalrepo.Event{event})
	response.WriteHeader(http.StatusNoContent)
}

type linkedIssueResource struct {
	ID         uuid.UUID `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
	Status     string    `json:"status"`
	LinkedAt   string    `json:"linkedAt"`
}

func (handler *handler) listIssues(response http.ResponseWriter, request *http.Request) {
	goalID, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	issues, err := handler.options.Store.ListIssues(request.Context(), goalID, 500)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]linkedIssueResource, 0, len(issues))
	for _, issue := range issues {
		nodes = append(nodes, linkedIssueResource{
			ID: issue.ID, Identifier: issue.Identifier, Title: issue.Title, Status: issue.Status,
			LinkedAt: issue.LinkedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

// resolveIssue finds the issue in the path inside the goal's workspace.
func (handler *handler) resolveIssue(response http.ResponseWriter, request *http.Request, scope identity.Scope) (uuid.UUID, bool) {
	reference := chi.URLParam(request, "issueRef")
	user := auth.MustUser(request.Context())
	issueScope, err := handler.options.Authorization.AuthorizeIssueReference(request.Context(), user.ID, reference, identity.PermissionWrite)
	if !workmanagement.WriteAuthorization(response, request, err, "Issue") {
		return uuid.Nil, false
	}
	if issueScope.WorkspaceID != scope.WorkspaceID || handler.options.Issues == nil {
		workmanagement.WriteNotFound(response, request, "Issue")
		return uuid.Nil, false
	}
	issue, err := handler.options.Issues.GetIssue(request.Context(), reference)
	if err != nil {
		workmanagement.WriteNotFound(response, request, "Issue")
		return uuid.Nil, false
	}
	return issue.ID, true
}

func (handler *handler) linkIssue(response http.ResponseWriter, request *http.Request) {
	goalID, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	issueID, ok := handler.resolveIssue(response, request, scope)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if err := handler.options.Store.LinkIssue(request.Context(), scope.WorkspaceID, goalID, issueID, user.ID, handler.options.Clock().UTC()); err != nil {
		handler.writeError(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handler) unlinkIssue(response http.ResponseWriter, request *http.Request) {
	goalID, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	issueID, ok := handler.resolveIssue(response, request, scope)
	if !ok {
		return
	}
	if err := handler.options.Store.UnlinkIssue(request.Context(), goalID, issueID); err != nil {
		handler.writeError(response, request, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type workflowSummary struct {
	ID          uuid.UUID `json:"id"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	TriggerType string    `json:"triggerType"`
	Risk        string    `json:"risk"`
	Version     int       `json:"version"`
	UpdatedAt   string    `json:"updatedAt"`
}

func (handler *handler) listWorkflows(response http.ResponseWriter, request *http.Request) {
	goalID, scope, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	if handler.options.Automations == nil {
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": []workflowSummary{}})
		return
	}
	found, err := handler.options.Automations.List(request.Context(), scope.WorkspaceID, automationrepo.ListFilter{GoalID: &goalID}, nil, 100)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]workflowSummary, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, workflowSummary{
			ID: item.ID, Name: item.Name, Status: string(item.Status), TriggerType: string(item.Trigger.Type),
			Risk: string(item.Risk), Version: item.Version, UpdatedAt: item.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

type approvalSummary struct {
	ID          uuid.UUID  `json:"id"`
	Kind        string     `json:"kind"`
	Risk        string     `json:"risk"`
	Title       string     `json:"title"`
	Status      string     `json:"status"`
	IssueID     *uuid.UUID `json:"issueId"`
	WorkflowID  *uuid.UUID `json:"workflowId"`
	RequestedAt string     `json:"requestedAt"`
}

func (handler *handler) listApprovals(response http.ResponseWriter, request *http.Request) {
	goalID, scope, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	if handler.options.Approvals == nil {
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": []approvalSummary{}})
		return
	}
	found, err := handler.options.Approvals.List(request.Context(), scope.WorkspaceID, approvals.ListFilter{GoalID: &goalID}, nil, 100)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]approvalSummary, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, approvalSummary{
			ID: item.ID, Kind: approvals.WireKind(item.Kind), Risk: string(item.Risk), Title: item.Title, Status: string(item.Status),
			IssueID: item.IssueID, WorkflowID: item.AutomationID, RequestedAt: item.RequestedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

type planSummary struct {
	ID               uuid.UUID `json:"id"`
	Status           string    `json:"status"`
	Source           string    `json:"source"`
	Version          int       `json:"version"`
	GenerationStatus string    `json:"generationStatus"`
	ValidationStatus string    `json:"validationStatus"`
	CompileStatus    string    `json:"compileStatus"`
	CreatedAt        string    `json:"createdAt"`
}

func (handler *handler) listPlans(response http.ResponseWriter, request *http.Request) {
	goalID, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	if handler.options.Plans == nil {
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": []planSummary{}})
		return
	}
	found, err := handler.options.Plans.ListForGoal(request.Context(), goalID, 100)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]planSummary, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, planSummary{
			ID: item.ID, Status: wirePlanStatus(item.Status), Source: string(item.Source), Version: item.CurrentVersion,
			GenerationStatus: item.GenerationStatus, ValidationStatus: item.ValidationStatus, CompileStatus: item.CompileStatus,
			CreatedAt: item.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

func wirePlanStatus(status string) string {
	if status == plans.StatusPendingApproval {
		return "pendingApproval"
	}
	return status
}

func (handler *handler) writeError(response http.ResponseWriter, request *http.Request, err error) {
	var transition *goalrepo.TransitionError
	switch {
	case errors.As(err, &transition):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "GOAL_TRANSITION_INVALID",
			fmt.Sprintf("A goal cannot move from %q to %q.", transition.From, transition.To),
			map[string]string{"from": string(transition.From), "to": string(transition.To)})
	case errors.Is(err, goalrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, "Goal")
	case errors.Is(err, goalrepo.ErrConflict):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "PROJECT_NOT_FOUND",
			"That project does not exist in this workspace.", nil)
	default:
		workmanagement.WriteInternal(response, request)
	}
}

func formatTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic("construct goal handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
