// Package approvals exports the authenticated /api/v1/approvals mount: the
// decisions waiting on a person and the two ways to make them.
package approvals

import (
	"context"
	"errors"
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
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Authorizer is the narrow workspace/approval/issue boundary.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
	AuthorizeApproval(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
	AuthorizeIssue(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
}

// Store is the approval persistence these routes call.
type Store interface {
	List(context.Context, uuid.UUID, approvalrepo.ListFilter, *approvalrepo.Cursor, int) ([]approvalrepo.Approval, error)
	PendingFor(context.Context, uuid.UUID, uuid.UUID, identity.Role, int) ([]approvalrepo.Approval, error)
	Get(context.Context, uuid.UUID) (approvalrepo.Approval, error)
	Create(context.Context, approvalrepo.CreateParams) (approvalrepo.Approval, approvalrepo.Event, error)
	Resolve(context.Context, uuid.UUID, approvalrepo.Resolution) (approvalrepo.Approval, []approvalrepo.Event, error)
}

// Options are explicit process dependencies.
type Options struct {
	Pool             *pgxpool.Pool
	Store            Store
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

// NewMount validates dependencies and builds the approvals subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("approval handler session resolver is nil")
	case options.Authorization == nil:
		return httpapi.Mount{}, errors.New("approval handler authorizer is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("approval handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("approval handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return httpapi.Mount{}, errors.New("approval handler idempotency store is nil")
	}
	if options.Store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("approval handler pool is nil")
		}
		store, err := approvalrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Store = store
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.list)
	router.Post("/", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.create)).ServeHTTP)
	router.Get("/{approvalId}", target.get)
	router.Post("/{approvalId}/approve", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock,
		http.HandlerFunc(target.decide(approvalrepo.DecisionApproved))).ServeHTTP)
	router.Post("/{approvalId}/reject", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock,
		http.HandlerFunc(target.decide(approvalrepo.DecisionRejected))).ServeHTTP)
	return httpapi.Mount{Prefix: "/api/v1/approvals", Handler: router}, nil
}

type issueRef struct {
	ID         uuid.UUID `json:"id"`
	Identifier string    `json:"identifier"`
	Title      string    `json:"title"`
}

type requestedFrom struct {
	UserID *uuid.UUID `json:"userId"`
	Role   *string    `json:"role"`
}

type resource struct {
	ID                uuid.UUID      `json:"id"`
	WorkspaceID       uuid.UUID      `json:"workspaceId"`
	Kind              string         `json:"kind"`
	Risk              string         `json:"risk"`
	Title             string         `json:"title"`
	Description       *string        `json:"description"`
	GoalID            *uuid.UUID     `json:"goalId"`
	PlanID            *uuid.UUID     `json:"planId"`
	IssueID           *uuid.UUID     `json:"issueId"`
	Issue             *issueRef      `json:"issue"`
	WorkflowID        *uuid.UUID     `json:"workflowId"`
	WorkflowRunID     *uuid.UUID     `json:"workflowRunId"`
	WorkflowStepRunID *uuid.UUID     `json:"workflowStepRunId"`
	RequestedFrom     requestedFrom  `json:"requestedFrom"`
	RequestedBy       *core.ActorKey `json:"requestedBy"`
	Status            string         `json:"status"`
	DecisionNote      *string        `json:"decisionNote"`
	ResolvedBy        *uuid.UUID     `json:"resolvedBy"`
	RequestedAt       string         `json:"requestedAt"`
	ExpiresAt         *string        `json:"expiresAt"`
	ResolvedAt        *string        `json:"resolvedAt"`
}

type connection struct {
	Nodes    []resource              `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

func serialize(approval approvalrepo.Approval) resource {
	out := resource{
		ID: approval.ID, WorkspaceID: approval.WorkspaceID, Kind: approvalrepo.WireKind(approval.Kind), Risk: string(approval.Risk),
		Title: approval.Title, Description: approval.Description, GoalID: approval.GoalID, PlanID: approval.PlanID, IssueID: approval.IssueID,
		WorkflowID: approval.AutomationID, WorkflowRunID: approval.AutomationRunID, WorkflowStepRunID: approval.AutomationStepRunID,
		Status: string(approval.Status), DecisionNote: approval.DecisionNote, ResolvedBy: approval.ResolvedBy,
		RequestedAt: approval.RequestedAt.UTC().Format(time.RFC3339Nano), ExpiresAt: formatTime(approval.ExpiresAt), ResolvedAt: formatTime(approval.ResolvedAt),
	}
	if approval.Issue != nil {
		out.Issue = &issueRef{ID: approval.Issue.ID, Identifier: approval.Issue.Identifier, Title: approval.Issue.Title}
	}
	out.RequestedFrom.UserID = approval.RequestedFromUserID
	if approval.RequestedFromRole != "" {
		role := approval.RequestedFromRole
		out.RequestedFrom.Role = &role
	}
	if approval.RequestedBy != nil {
		out.RequestedBy = &core.ActorKey{Type: string(approval.RequestedByType), ID: *approval.RequestedBy}
	}
	return out
}

func (handler *handler) list(response http.ResponseWriter, request *http.Request) {
	page, ok := workmanagement.ParsePage(response, request, "workspaceId", "status", "kind", "mine", "goalId", "issueId", "workflowId")
	if !ok {
		return
	}
	query := request.URL.Query()
	workspaceID, ok := workmanagement.ParseCanonicalUUID(query.Get("workspaceId"))
	if !ok {
		workmanagement.WriteInvalidQuery(response, request, "/query/workspaceId", "workspaceId must be a canonical UUID.")
		return
	}
	filter := approvalrepo.ListFilter{}
	if status := query.Get("status"); status != "" {
		switch approvalrepo.Status(status) {
		case approvalrepo.StatusPending, approvalrepo.StatusApproved, approvalrepo.StatusRejected, approvalrepo.StatusExpired:
			filter.Status = approvalrepo.Status(status)
		default:
			workmanagement.WriteInvalidQuery(response, request, "/query/status", "status is pending, approved, rejected or expired.")
			return
		}
	}
	if kind := query.Get("kind"); kind != "" {
		parsed, ok := approvalrepo.ParseWireKind(kind)
		if !ok {
			workmanagement.WriteInvalidQuery(response, request, "/query/kind", "kind is not an approval kind.")
			return
		}
		filter.Kind = parsed
	}
	for name, target := range map[string]**uuid.UUID{"goalId": &filter.GoalID, "issueId": &filter.IssueID, "workflowId": &filter.AutomationID} {
		if raw := query.Get(name); raw != "" {
			parsed, ok := workmanagement.ParseCanonicalUUID(raw)
			if !ok {
				workmanagement.WriteInvalidQuery(response, request, "/query/"+name, name+" must be a canonical UUID.")
				return
			}
			*target = &parsed
		}
	}
	mine := false
	if raw := query.Get("mine"); raw != "" {
		if raw != "true" && raw != "false" {
			workmanagement.WriteInvalidQuery(response, request, "/query/mine", "mine must be true or false.")
			return
		}
		mine = raw == "true"
	}
	user := auth.MustUser(request.Context())
	role, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionRead)
	if !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	if mine {
		found, err := handler.options.Store.PendingFor(request.Context(), workspaceID, user.ID, role, 100)
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		nodes := make([]resource, 0, len(found))
		for _, item := range found {
			nodes = append(nodes, serialize(item))
		}
		httpapi.WriteJSON(response, http.StatusOK, connection{Nodes: nodes, PageInfo: workmanagement.PageInfo{}})
		return
	}
	scope := workmanagement.CursorScope("approvals.list", workspaceID.String(), string(filter.Status), string(filter.Kind),
		query.Get("goalId"), query.Get("issueId"), query.Get("workflowId"))
	var after *approvalrepo.Cursor
	if page.After != "" {
		var cursor approvalrepo.Cursor
		if httpapi.DecodeCursor(page.After, scope, &cursor) != nil || cursor.ID == uuid.Nil || cursor.RequestedAt.IsZero() {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	found, err := handler.options.Store.List(request.Context(), workspaceID, filter, after, page.First+1)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	hasNext := len(found) > page.First
	if hasNext {
		found = found[:page.First]
	}
	nodes := make([]resource, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, serialize(item))
	}
	var endCursor *string
	if len(found) > 0 {
		last := found[len(found)-1]
		encoded, err := httpapi.EncodeCursor(scope, approvalrepo.Cursor{RequestedAt: last.RequestedAt, ID: last.ID})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, connection{Nodes: nodes, PageInfo: workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: endCursor}})
}

func (handler *handler) get(response http.ResponseWriter, request *http.Request) {
	approvalID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "approvalId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Approval")
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeApproval(request.Context(), user.ID, approvalID, identity.PermissionRead); !workmanagement.WriteAuthorization(response, request, err, "Approval") {
		return
	}
	approval, err := handler.options.Store.Get(request.Context(), approvalID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serialize(approval))
}

type decisionBody struct {
	Note workmanagement.Optional[string] `json:"note"`
}

// decide resolves one approval. The actor must be the addressee, or hold the
// addressed role or a stronger one; a high-risk approval additionally needs
// settings.write. Approving an issue start releases the issue in the same
// transaction and publishes its facts beside the approval's.
func (handler *handler) decide(decision approvalrepo.Decision) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		approvalID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "approvalId"))
		if !ok {
			workmanagement.WriteNotFound(response, request, "Approval")
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := handler.options.Authorization.AuthorizeApproval(request.Context(), user.ID, approvalID, identity.PermissionWrite)
		if !workmanagement.WriteAuthorization(response, request, err, "Approval") {
			return
		}
		body, _, ok := workmanagement.DecodeJSON[decisionBody](response, request)
		if !ok {
			return
		}
		note := ""
		if body.Note.Set && !body.Note.Null {
			note = strings.TrimSpace(body.Note.Value)
			if utf8.RuneCountInString(note) > 5000 {
				workmanagement.WriteValidation(response, request, httpapi.FieldError{Path: "/note", Code: "too_big", Message: "note must contain at most 5000 characters."})
				return
			}
		}
		approval, err := handler.options.Store.Get(request.Context(), approvalID)
		if err != nil {
			handler.writeError(response, request, err)
			return
		}
		if reason, allowed := MayResolve(approval, user.ID, scope.Role); !allowed {
			httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN",
				"You may not resolve this approval.", map[string]string{"reason": reason})
			return
		}
		resolved, events, err := handler.options.Store.Resolve(request.Context(), approvalID, approvalrepo.Resolution{
			Decision: decision, Note: note, ActorID: user.ID, Now: handler.options.Clock().UTC(), NewID: handler.options.NewID,
		})
		if err != nil {
			handler.writeError(response, request, err)
			return
		}
		shared.PublishLedger(request.Context(), handler.options.Broadcaster, events)
		httpapi.WriteJSON(response, http.StatusOK, serialize(resolved))
	}
}

// MayResolve applies the resolution rule (D7): the addressee, or the
// addressed role or stronger, and settings.write for high risk. The reason
// names what is missing without revealing who else could act.
func MayResolve(approval approvalrepo.Approval, userID uuid.UUID, role identity.Role) (string, bool) {
	addressed := false
	switch {
	case approval.RequestedFromUserID != nil:
		addressed = *approval.RequestedFromUserID == userID
	case approval.RequestedFromRole != "":
		addressed = identity.RoleAtLeast(role, identity.Role(approval.RequestedFromRole))
	}
	if !addressed {
		return "not_addressee", false
	}
	if approval.Risk == approvalrepo.RiskHigh && !role.Allows(identity.PermissionSettingsWrite) {
		return "admin_required", false
	}
	return "", true
}

type createBody struct {
	WorkspaceID         string                          `json:"workspaceId"`
	Kind                string                          `json:"kind"`
	IssueID             string                          `json:"issueId"`
	Title               string                          `json:"title"`
	Description         workmanagement.Optional[string] `json:"description"`
	RequestedFromUserID workmanagement.Optional[string] `json:"requestedFromUserId"`
	RequestedFromRole   workmanagement.Optional[string] `json:"requestedFromRole"`
	ExpiresAt           workmanagement.Optional[string] `json:"expiresAt"`
	Risk                workmanagement.Optional[string] `json:"risk"`
}

// create opens a manual issue-start gate on any issue. Every other kind is
// opened by the system: a plan compile, a workflow step, a tool call.
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
	if body.Kind != "issueStart" {
		fields = append(fields, httpapi.FieldError{Path: "/kind", Code: "invalid_enum_value", Message: "kind must be issueStart."})
	}
	issueID, validIssue := workmanagement.ParseCanonicalUUID(body.IssueID)
	if !validIssue {
		fields = append(fields, httpapi.FieldError{Path: "/issueId", Code: "invalid", Message: "issueId must be a canonical UUID."})
	}
	title := strings.TrimSpace(body.Title)
	if length := utf8.RuneCountInString(title); length < 1 || length > 500 {
		fields = append(fields, httpapi.FieldError{Path: "/title", Code: "invalid", Message: "title must contain 1 to 500 characters."})
	}
	params := approvalrepo.CreateParams{
		ID: handler.options.NewID(), WorkspaceID: workspaceID, Kind: approvalrepo.KindIssueStart, Title: title, IssueID: &issueID,
		RequestedByType: approvalrepo.ActorUser, RequestedAt: handler.options.Clock().UTC(), NewID: handler.options.NewID,
	}
	if body.Description.Set && !body.Description.Null {
		if utf8.RuneCountInString(body.Description.Value) > 20000 {
			fields = append(fields, httpapi.FieldError{Path: "/description", Code: "too_big", Message: "description must contain at most 20000 characters."})
		}
		params.Description = &body.Description.Value
	}
	if body.RequestedFromUserID.Set && !body.RequestedFromUserID.Null {
		parsed, ok := workmanagement.ParseCanonicalUUID(body.RequestedFromUserID.Value)
		if !ok {
			fields = append(fields, httpapi.FieldError{Path: "/requestedFromUserId", Code: "invalid", Message: "requestedFromUserId must be a canonical UUID."})
		} else {
			params.RequestedFromUserID = &parsed
		}
	}
	if body.RequestedFromRole.Set && !body.RequestedFromRole.Null {
		switch identity.Role(body.RequestedFromRole.Value) {
		case identity.RoleOwner, identity.RoleAdmin, identity.RoleMember:
			params.RequestedFromRole = body.RequestedFromRole.Value
		default:
			fields = append(fields, httpapi.FieldError{Path: "/requestedFromRole", Code: "invalid_enum_value", Message: "requestedFromRole is owner, admin or member."})
		}
	}
	if params.RequestedFromUserID == nil && params.RequestedFromRole == "" {
		params.RequestedFromRole = string(identity.RoleAdmin)
	}
	if body.Risk.Set && !body.Risk.Null {
		switch approvalrepo.Risk(body.Risk.Value) {
		case approvalrepo.RiskLow, approvalrepo.RiskMedium, approvalrepo.RiskHigh:
			params.Risk = approvalrepo.Risk(body.Risk.Value)
		default:
			fields = append(fields, httpapi.FieldError{Path: "/risk", Code: "invalid_enum_value", Message: "risk is low, medium or high."})
		}
	}
	if body.ExpiresAt.Set && !body.ExpiresAt.Null {
		parsed, err := time.Parse(time.RFC3339, body.ExpiresAt.Value)
		if err != nil || !parsed.After(params.RequestedAt) {
			fields = append(fields, httpapi.FieldError{Path: "/expiresAt", Code: "invalid", Message: "expiresAt must be an RFC 3339 instant in the future."})
		} else {
			expires := parsed.UTC()
			params.ExpiresAt = &expires
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
	issueScope, err := handler.options.Authorization.AuthorizeIssue(request.Context(), user.ID, issueID, identity.PermissionWrite)
	if !workmanagement.WriteAuthorization(response, request, err, "Issue") {
		return
	}
	if issueScope.WorkspaceID != workspaceID {
		workmanagement.WriteNotFound(response, request, "Issue")
		return
	}
	params.RequestedBy = &user.ID
	approval, event, err := handler.options.Store.Create(request.Context(), params)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []approvalrepo.Event{event})
	response.Header().Set("Location", "/api/v1/approvals/"+approval.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, serialize(approval))
}

func (handler *handler) writeError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, approvalrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, "Approval")
	case errors.Is(err, approvalrepo.ErrAlreadyResolved):
		httpapi.WriteError(response, request, http.StatusConflict, "APPROVAL_RESOLVED", "This approval was already resolved.", nil)
	case errors.Is(err, approvalrepo.ErrApprovalRequired):
		httpapi.WriteError(response, request, http.StatusConflict, "APPROVAL_REQUIRED",
			"The issue is still waiting on another approval.", nil)
	case errors.Is(err, approvalrepo.ErrConflict):
		httpapi.WriteError(response, request, http.StatusConflict, "CONFLICT", "The issue already has a pending start approval.", nil)
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
		panic("construct approval handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
