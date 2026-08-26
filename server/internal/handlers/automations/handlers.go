// Package automations exports the authenticated /api/v1/workflows mount. The
// URL says workflow because that is the product noun; the Go and SQL
// identifiers say automation (D1).
package automations

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/handlers/automationruns"
	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
)

// Authorizer is the narrow workspace/workflow boundary.
type Authorizer interface {
	AuthorizeWorkspace(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Role, error)
	AuthorizeAutomation(context.Context, uuid.UUID, uuid.UUID, identity.Permission) (identity.Scope, error)
}

// Store is the workflow persistence these routes call.
type Store interface {
	List(context.Context, uuid.UUID, automationrepo.ListFilter, *automationrepo.Cursor, int) ([]automationrepo.Automation, error)
	Get(context.Context, uuid.UUID) (automationrepo.Automation, error)
	Create(context.Context, automationrepo.CreateParams) (automationrepo.Automation, automationrepo.Event, error)
	Update(context.Context, automationrepo.UpdateParams) (automationrepo.Automation, error)
	SetStatus(context.Context, uuid.UUID, automationrepo.Status, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Automation, automationrepo.Event, error)
	Archive(context.Context, uuid.UUID, uuid.UUID, time.Time, func() uuid.UUID) (automationrepo.Automation, automationrepo.Event, error)
	ListVersions(context.Context, uuid.UUID) ([]automationrepo.Version, error)
	RotateWebhookSecret(context.Context, uuid.UUID, string, time.Time) error
	ListRuns(context.Context, automationrepo.RunListFilter, *automationrepo.RunCursor, int) ([]automationrepo.Run, error)
	CountRuns(context.Context, uuid.UUID) (automationrepo.RunCounts, error)
	CreateRun(context.Context, automationrepo.CreateRunParams) (automationrepo.Run, bool, error)
}

// ConnectionReader lists a workspace's provider connections without opening
// a credential; nil means nothing is connected.
type ConnectionReader interface {
	ListConnections(context.Context, uuid.UUID) ([]integrationcore.Connection, error)
}

// Options are explicit process dependencies.
type Options struct {
	Pool             *pgxpool.Pool
	Store            Store
	Registry         *integrationcore.Registry
	Connections      ConnectionReader
	Engine           automation.Engine
	Sessions         auth.SessionResolver
	Authorization    Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
	// Starter executes the runs a manual request creates. Nil means the
	// deployment does not execute workflows; manual runs answer
	// WORKFLOWS_DISABLED rather than leaving a run nobody will start.
	Starter automationrun.Starter
	// Schedules registers schedule triggers with whatever fires them; nil
	// records nothing.
	Schedules automationrun.Schedules
	Logger    *slog.Logger
	// Random mints webhook tokens; nil uses crypto/rand.
	Random io.Reader
}

type handler struct {
	options Options
}

// NewMount validates dependencies and builds the workflows subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return httpapi.Mount{}, errors.New("workflow handler session resolver is nil")
	case options.Authorization == nil:
		return httpapi.Mount{}, errors.New("workflow handler authorizer is nil")
	case options.Clock == nil:
		return httpapi.Mount{}, errors.New("workflow handler clock is nil")
	case options.NewID == nil:
		return httpapi.Mount{}, errors.New("workflow handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return httpapi.Mount{}, errors.New("workflow handler idempotency store is nil")
	}
	if options.Store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("workflow handler pool is nil")
		}
		store, err := automationrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		options.Store = store
	}
	if options.Engine == nil {
		options.Engine = automation.NoopEngine{}
	}
	if options.Random == nil {
		options.Random = rand.Reader
	}
	if options.Schedules == nil {
		options.Schedules = automationrun.NoopSchedules{}
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	target := &handler{options: options}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.list)
	router.Post("/", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.create)).ServeHTTP)
	router.Get("/{workflowId}", target.get)
	router.Patch("/{workflowId}", target.update)
	router.Delete("/{workflowId}", target.archive)
	router.Post("/{workflowId}/activate", target.activate)
	router.Post("/{workflowId}/pause", target.pause)
	router.Get("/{workflowId}/runs", target.listRuns)
	router.Post("/{workflowId}/runs", workmanagement.RequireIdempotency(options.IdempotencyStore, options.Clock, http.HandlerFunc(target.run)).ServeHTTP)
	router.Get("/{workflowId}/versions", target.listVersions)
	router.Post("/{workflowId}/webhook", target.rotateWebhook)
	return httpapi.Mount{Prefix: "/api/v1/workflows", Handler: router}, nil
}

// CatalogFor is the validator's view of the registry for one workspace: the
// registered tools plus which providers this workspace has connected.
func CatalogFor(ctx context.Context, registry *integrationcore.Registry, connections ConnectionReader, workspaceID uuid.UUID) automation.Catalog {
	if registry == nil {
		return nil
	}
	var connected []string
	if connections != nil {
		if found, err := connections.ListConnections(ctx, workspaceID); err == nil {
			for _, connection := range found {
				if connection.Status.Usable() {
					connected = append(connected, connection.Provider)
				}
			}
		}
	}
	return integrationcore.NewCatalog(registry, integrationcore.ConnectedSet(connected))
}

type triggerResource struct {
	Type      string `json:"type"`
	Provider  string `json:"provider,omitempty"`
	Operation string `json:"operation,omitempty"`
	Event     string `json:"event,omitempty"`
	Cron      string `json:"cron,omitempty"`
	Timezone  string `json:"timezone,omitempty"`
}

type requiredConnection struct {
	Provider  string `json:"provider"`
	Connected bool   `json:"connected"`
}

type runSummary struct {
	ID        uuid.UUID `json:"id"`
	Status    string    `json:"status"`
	CreatedAt string    `json:"createdAt"`
}

type runCounts struct {
	Total     int `json:"total"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

type validationResource struct {
	Errors   []automation.FieldError `json:"errors"`
	Warnings []automation.FieldError `json:"warnings"`
}

type resource struct {
	ID                  uuid.UUID            `json:"id"`
	WorkspaceID         uuid.UUID            `json:"workspaceId"`
	ProjectID           *uuid.UUID           `json:"projectId"`
	GoalID              *uuid.UUID           `json:"goalId"`
	Name                string               `json:"name"`
	Description         *string              `json:"description"`
	Status              string               `json:"status"`
	Version             int                  `json:"version"`
	Revision            int                  `json:"revision"`
	Definition          json.RawMessage      `json:"definition"`
	Layout              json.RawMessage      `json:"layout"`
	Trigger             triggerResource      `json:"trigger"`
	Risk                string               `json:"risk"`
	Engine              string               `json:"engine"`
	ActivepiecesFlowID  *string              `json:"activepiecesFlowId,omitempty"`
	RequiredConnections []requiredConnection `json:"requiredConnections"`
	Validation          validationResource   `json:"validation"`
	CreatedBy           *core.ActorKey       `json:"createdBy"`
	CreatedAt           string               `json:"createdAt"`
	UpdatedAt           string               `json:"updatedAt"`
	LastRun             *runSummary          `json:"lastRun"`
	RunCounts           runCounts            `json:"runCounts"`
}

type connection struct {
	Nodes    []resource              `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

// Serialize builds the resource. Validation and required connections are
// computed from the stored definition against the catalog, so a workflow
// saved before a connection was revoked shows the gap on the next read.
func (handler *handler) serialize(ctx context.Context, item automationrepo.Automation, catalog automation.Catalog, withRuns bool) resource {
	out := resource{
		ID: item.ID, WorkspaceID: item.WorkspaceID, ProjectID: item.ProjectID, GoalID: item.GoalID, Name: item.Name, Description: item.Description,
		Status: string(item.Status), Version: item.Version, Revision: item.Revision, Definition: item.Definition, Layout: item.Layout,
		Trigger: triggerResource{Type: string(item.Trigger.Type), Provider: item.Trigger.Provider, Operation: item.Trigger.Operation,
			Event: item.Trigger.Event, Cron: item.Trigger.Cron, Timezone: item.Trigger.Timezone},
		Risk: string(item.Risk), Engine: string(item.Engine), RequiredConnections: []requiredConnection{},
		Validation: validationResource{Errors: []automation.FieldError{}, Warnings: []automation.FieldError{}},
		CreatedAt:  item.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: item.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if item.Engine == automationrepo.EngineActivepieces {
		out.ActivepiecesFlowID = item.EngineFlowID
	}
	if item.CreatedBy != nil {
		out.CreatedBy = &core.ActorKey{Type: "user", ID: *item.CreatedBy}
	}
	if definition, findings := automation.ParseDefinition(item.Definition); len(findings) == 0 {
		report := automation.ValidateDefinition(definition, automation.ValidateOptions{Catalog: catalog})
		out.Validation = validationResource{Errors: prefixDefinition(report.Errors), Warnings: prefixDefinition(report.Warnings)}
		out.RequiredConnections = RequiredConnections(definition, catalog)
	}
	if withRuns {
		if runs, err := handler.options.Store.ListRuns(ctx, automationrepo.RunListFilter{WorkspaceID: item.WorkspaceID, AutomationID: &item.ID}, nil, 1); err == nil && len(runs) == 1 {
			out.LastRun = &runSummary{ID: runs[0].ID, Status: string(runs[0].Status), CreatedAt: runs[0].CreatedAt.UTC().Format(time.RFC3339Nano)}
		}
		if counts, err := handler.options.Store.CountRuns(ctx, item.ID); err == nil {
			out.RunCounts = runCounts{Total: counts.Total, Succeeded: counts.Succeeded, Failed: counts.Failed}
		}
	}
	return out
}

// RequiredConnections lists the providers a definition needs a connection
// for, and whether the workspace has one. Berry's own tools need none; a tool
// the catalog does not know is assumed to need one, so an unknown provider
// shows as missing rather than silently satisfied.
func RequiredConnections(definition automation.Definition, catalog automation.Catalog) []requiredConnection {
	required := map[string]bool{}
	note := func(provider, operation string, kind automation.ToolKind) {
		if provider == "" {
			return
		}
		if catalog != nil {
			if spec, ok := catalog.Tool(provider, operation, kind); ok && !spec.ConnectionRequired {
				return
			}
		}
		required[provider] = true
	}
	if definition.Trigger.Type == automation.TriggerIntegration {
		note(definition.Trigger.Provider, definition.Trigger.Operation, automation.ToolTrigger)
	}
	for _, step := range definition.Steps {
		if step.Type == automation.StepAction && step.Action != nil {
			note(step.Action.Provider, step.Action.Operation, automation.ToolAction)
		}
	}
	providers := make([]string, 0, len(required))
	for provider := range required {
		providers = append(providers, provider)
	}
	sort.Strings(providers)
	out := make([]requiredConnection, 0, len(providers))
	for _, provider := range providers {
		out = append(out, requiredConnection{Provider: provider, Connected: catalog != nil && catalog.Connected(provider)})
	}
	return out
}

func prefixDefinition(findings []automation.FieldError) []automation.FieldError {
	out := make([]automation.FieldError, 0, len(findings))
	for _, finding := range findings {
		finding.Path = "/definition" + finding.Path
		out = append(out, finding)
	}
	return out
}

func (handler *handler) catalog(ctx context.Context, workspaceID uuid.UUID) automation.Catalog {
	return CatalogFor(ctx, handler.options.Registry, handler.options.Connections, workspaceID)
}

func (handler *handler) list(response http.ResponseWriter, request *http.Request) {
	page, ok := workmanagement.ParsePage(response, request, "workspaceId", "status", "triggerType", "goalId", "projectId", "query")
	if !ok {
		return
	}
	query := request.URL.Query()
	workspaceID, ok := workmanagement.ParseCanonicalUUID(query.Get("workspaceId"))
	if !ok {
		workmanagement.WriteInvalidQuery(response, request, "/query/workspaceId", "workspaceId must be a canonical UUID.")
		return
	}
	filter := automationrepo.ListFilter{Query: strings.TrimSpace(query.Get("query"))}
	if status := query.Get("status"); status != "" {
		switch automationrepo.Status(status) {
		case automationrepo.StatusDraft, automationrepo.StatusActive, automationrepo.StatusPaused:
			filter.Status = automationrepo.Status(status)
		default:
			workmanagement.WriteInvalidQuery(response, request, "/query/status", "status is draft, active or paused.")
			return
		}
	}
	if kind := query.Get("triggerType"); kind != "" {
		if !automation.TriggerType(kind).Valid() {
			workmanagement.WriteInvalidQuery(response, request, "/query/triggerType", "triggerType is not a trigger type.")
			return
		}
		filter.TriggerType = automation.TriggerType(kind)
	}
	for name, target := range map[string]**uuid.UUID{"goalId": &filter.GoalID, "projectId": &filter.ProjectID} {
		if raw := query.Get(name); raw != "" {
			parsed, ok := workmanagement.ParseCanonicalUUID(raw)
			if !ok {
				workmanagement.WriteInvalidQuery(response, request, "/query/"+name, name+" must be a canonical UUID.")
				return
			}
			*target = &parsed
		}
	}
	if utf8.RuneCountInString(filter.Query) > 200 {
		workmanagement.WriteInvalidQuery(response, request, "/query/query", "query is at most 200 characters.")
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionRead); !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	scope := workmanagement.CursorScope("workflows.list", workspaceID.String(), string(filter.Status), string(filter.TriggerType),
		query.Get("goalId"), query.Get("projectId"), filter.Query)
	var after *automationrepo.Cursor
	if page.After != "" {
		var cursor automationrepo.Cursor
		if httpapi.DecodeCursor(page.After, scope, &cursor) != nil || cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
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
	catalog := handler.catalog(request.Context(), workspaceID)
	nodes := make([]resource, 0, len(found))
	for _, item := range found {
		nodes = append(nodes, handler.serialize(request.Context(), item, catalog, false))
	}
	var endCursor *string
	if len(found) > 0 {
		last := found[len(found)-1]
		encoded, err := httpapi.EncodeCursor(scope, automationrepo.Cursor{UpdatedAt: last.UpdatedAt, ID: last.ID})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, connection{Nodes: nodes, PageInfo: workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: endCursor}})
}

type createBody struct {
	WorkspaceID string                          `json:"workspaceId"`
	Name        string                          `json:"name"`
	Description workmanagement.Optional[string] `json:"description"`
	ProjectID   workmanagement.Optional[string] `json:"projectId"`
	GoalID      workmanagement.Optional[string] `json:"goalId"`
	Definition  json.RawMessage                 `json:"definition"`
	Layout      json.RawMessage                 `json:"layout"`
}

// parseDefinition decodes and validates a definition against the workspace
// catalog. Draft saves only warn about missing connections; activation is
// where they refuse.
func parseDefinition(response http.ResponseWriter, request *http.Request, raw json.RawMessage, catalog automation.Catalog) (automation.Definition, bool) {
	if len(raw) == 0 {
		writeDefinitionInvalid(response, request, []automation.FieldError{{Path: "/definition", Code: "STEP_FIELD_REQUIRED", Message: "A workflow needs a definition.", Severity: automation.SeverityError}})
		return automation.Definition{}, false
	}
	definition, findings := automation.ParseDefinition(raw)
	if len(findings) > 0 {
		writeDefinitionInvalid(response, request, prefixDefinition(findings))
		return automation.Definition{}, false
	}
	report := automation.ValidateDefinition(definition, automation.ValidateOptions{Catalog: catalog})
	if !report.Valid() {
		writeDefinitionInvalid(response, request, prefixDefinition(report.Errors))
		return automation.Definition{}, false
	}
	return definition, true
}

func writeDefinitionInvalid(response http.ResponseWriter, request *http.Request, fields []automation.FieldError) {
	httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "DEFINITION_INVALID",
		"The workflow definition is invalid.", map[string]any{"fields": fields})
}

func parseLayout(raw json.RawMessage) (json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	var object map[string]json.RawMessage
	if len(raw) > 65536 || json.Unmarshal(raw, &object) != nil || object == nil {
		return nil, false
	}
	return raw, true
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
	name := strings.TrimSpace(body.Name)
	if length := utf8.RuneCountInString(name); length < 1 || length > 200 {
		fields = append(fields, httpapi.FieldError{Path: "/name", Code: "invalid", Message: "name must contain 1 to 200 characters."})
	}
	var description *string
	if body.Description.Set && !body.Description.Null {
		if utf8.RuneCountInString(body.Description.Value) > 20000 {
			fields = append(fields, httpapi.FieldError{Path: "/description", Code: "too_big", Message: "description must contain at most 20000 characters."})
		}
		description = &body.Description.Value
	}
	var projectID, goalID *uuid.UUID
	for name, field := range map[string]struct {
		value  workmanagement.Optional[string]
		target **uuid.UUID
	}{"projectId": {body.ProjectID, &projectID}, "goalId": {body.GoalID, &goalID}} {
		if field.value.Set && !field.value.Null {
			parsed, ok := workmanagement.ParseCanonicalUUID(field.value.Value)
			if !ok {
				fields = append(fields, httpapi.FieldError{Path: "/" + name, Code: "invalid", Message: name + " must be a canonical UUID."})
			} else {
				*field.target = &parsed
			}
		}
	}
	layout, ok := parseLayout(body.Layout)
	if !ok {
		fields = append(fields, httpapi.FieldError{Path: "/layout", Code: "invalid_type", Message: "layout must be a JSON object of at most 64 KiB."})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return
	}
	user := auth.MustUser(request.Context())
	if _, err := handler.options.Authorization.AuthorizeWorkspace(request.Context(), user.ID, workspaceID, identity.PermissionWrite); !workmanagement.WriteAuthorization(response, request, err, "Workspace") {
		return
	}
	catalog := handler.catalog(request.Context(), workspaceID)
	definition, ok := parseDefinition(response, request, body.Definition, catalog)
	if !ok {
		return
	}
	created, event, err := handler.options.Store.Create(request.Context(), automationrepo.CreateParams{
		ID: handler.options.NewID(), WorkspaceID: workspaceID, ProjectID: projectID, GoalID: goalID, Name: name, Description: description,
		Definition: definition, Layout: layout, Engine: automationrepo.EngineNative, Catalog: catalog,
		CreatedBy: user.ID, CreatedAt: handler.options.Clock().UTC(), NewID: handler.options.NewID,
	})
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []automationrepo.Event{event})
	response.Header().Set("Location", "/api/v1/workflows/"+created.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, handler.serialize(request.Context(), created, catalog, true))
}

// authorize resolves the workflow in the path and checks one permission.
// Archived workflows read but never change.
func (handler *handler) authorize(response http.ResponseWriter, request *http.Request, permission identity.Permission) (automationrepo.Automation, identity.Scope, bool) {
	automationID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "workflowId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Workflow")
		return automationrepo.Automation{}, identity.Scope{}, false
	}
	user := auth.MustUser(request.Context())
	scope, err := handler.options.Authorization.AuthorizeAutomation(request.Context(), user.ID, automationID, permission)
	if !workmanagement.WriteAuthorization(response, request, err, "Workflow") {
		return automationrepo.Automation{}, identity.Scope{}, false
	}
	item, err := handler.options.Store.Get(request.Context(), automationID)
	if err != nil {
		handler.writeError(response, request, err)
		return automationrepo.Automation{}, identity.Scope{}, false
	}
	if item.Status == automationrepo.StatusArchived && permission != identity.PermissionRead {
		workmanagement.WriteNotFound(response, request, "Workflow")
		return automationrepo.Automation{}, identity.Scope{}, false
	}
	return item, scope, true
}

func (handler *handler) get(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), item, handler.catalog(request.Context(), item.WorkspaceID), true))
}

type updateBody struct {
	Name        workmanagement.Optional[string] `json:"name"`
	Description workmanagement.Optional[string] `json:"description"`
	Definition  json.RawMessage                 `json:"definition"`
	Layout      json.RawMessage                 `json:"layout"`
	GoalID      workmanagement.Optional[string] `json:"goalId"`
	ProjectID   workmanagement.Optional[string] `json:"projectId"`
	Revision    *int                            `json:"revision"`
}

func (handler *handler) update(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	body, _, ok := workmanagement.DecodeJSON[updateBody](response, request)
	if !ok {
		return
	}
	var fields []httpapi.FieldError
	if body.Revision == nil || *body.Revision < 1 {
		fields = append(fields, httpapi.FieldError{Path: "/revision", Code: "invalid", Message: "revision is the revision you last read."})
	}
	params := automationrepo.UpdateParams{AutomationID: item.ID, ActorID: auth.MustUser(request.Context()).ID, UpdatedAt: handler.options.Clock().UTC(), NewID: handler.options.NewID}
	if body.Revision != nil {
		params.ExpectedRevision = *body.Revision
	}
	changed := false
	if body.Name.Set {
		changed = true
		if body.Name.Null {
			fields = append(fields, httpapi.FieldError{Path: "/name", Code: "invalid_type", Message: "name cannot be null."})
		} else {
			name := strings.TrimSpace(body.Name.Value)
			if length := utf8.RuneCountInString(name); length < 1 || length > 200 {
				fields = append(fields, httpapi.FieldError{Path: "/name", Code: "invalid", Message: "name must contain 1 to 200 characters."})
			}
			params.Name = &name
		}
	}
	if body.Description.Set {
		changed = true
		params.DescriptionSet = true
		if !body.Description.Null {
			if utf8.RuneCountInString(body.Description.Value) > 20000 {
				fields = append(fields, httpapi.FieldError{Path: "/description", Code: "too_big", Message: "description must contain at most 20000 characters."})
			}
			params.Description = &body.Description.Value
		}
	}
	for name, field := range map[string]struct {
		value  workmanagement.Optional[string]
		set    *bool
		target **uuid.UUID
	}{"goalId": {body.GoalID, &params.GoalSet, &params.GoalID}, "projectId": {body.ProjectID, &params.ProjectSet, &params.ProjectID}} {
		if field.value.Set {
			changed = true
			*field.set = true
			if !field.value.Null {
				parsed, ok := workmanagement.ParseCanonicalUUID(field.value.Value)
				if !ok {
					fields = append(fields, httpapi.FieldError{Path: "/" + name, Code: "invalid", Message: name + " must be a canonical UUID."})
				} else {
					*field.target = &parsed
				}
			}
		}
	}
	if len(body.Layout) > 0 {
		changed = true
		layout, ok := parseLayout(body.Layout)
		if !ok {
			fields = append(fields, httpapi.FieldError{Path: "/layout", Code: "invalid_type", Message: "layout must be a JSON object of at most 64 KiB."})
		}
		params.Layout = layout
	}
	if !changed && len(body.Definition) == 0 {
		fields = append(fields, httpapi.FieldError{Path: "/", Code: "too_small", Message: "At least one field must be provided."})
	}
	if len(fields) > 0 {
		workmanagement.WriteValidation(response, request, fields...)
		return
	}
	catalog := handler.catalog(request.Context(), item.WorkspaceID)
	if len(body.Definition) > 0 {
		definition, ok := parseDefinition(response, request, body.Definition, catalog)
		if !ok {
			return
		}
		params.Definition = &definition
		params.Catalog = catalog
	}
	updated, err := handler.options.Store.Update(request.Context(), params)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), updated, catalog, true))
}

func (handler *handler) archive(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	_, event, err := handler.options.Store.Archive(request.Context(), item.ID, user.ID, handler.options.Clock().UTC(), handler.options.NewID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, []automationrepo.Event{event})
	// Best effort: the archived row already refuses runs, so a schedule
	// that outlives it fires into ErrNotActive; it is only noise to remove.
	if item.Trigger.Type == automation.TriggerSchedule {
		if err := handler.options.Schedules.Delete(context.WithoutCancel(request.Context()), item.ID); err != nil {
			handler.options.Logger.Warn("workflow schedule not deleted", "workflowId", item.ID, "error", err)
		}
	}
	response.WriteHeader(http.StatusNoContent)
}

// Activation errors, mapped by the HTTP layer and reused by the plan approve
// path so both decide the same way.
var (
	// ErrHighRisk means a high-risk workflow needs settings.write to activate.
	ErrHighRisk = errors.New("workflow activation needs settings.write")
)

// ConnectionsMissingError lists the providers an activation needs connected.
type ConnectionsMissingError struct {
	Providers []string
}

func (err *ConnectionsMissingError) Error() string { return "workflow connections missing" }

// DefinitionInvalidError carries the findings that stop an activation.
type DefinitionInvalidError struct {
	Fields []automation.FieldError
}

func (err *DefinitionInvalidError) Error() string { return "workflow definition invalid" }

// ActivationParams is one activation decision.
type ActivationParams struct {
	Automation automationrepo.Automation
	Role       identity.Role
	ActorID    uuid.UUID
	Catalog    automation.Catalog
	Engine     automation.Engine
	// Schedules receives schedule triggers; nil registers nothing.
	Schedules automationrun.Schedules
	Now       time.Time
	NewID     func() uuid.UUID
}

// Activate applies the activation rule: the definition must validate with
// every required connection present, a high-risk workflow needs
// settings.write, and a workflow mirrored in an external engine needs that
// engine. It records nothing on failure.
//
// Triggers start with the status. Berry event, manual and webhook triggers
// need no runtime call — the trigger dispatcher, the manual run route and
// the hook route all consult the status on every request — while a
// schedule trigger is registered through the Schedules seam before the
// status changes, so a schedule that exists for a workflow that failed to
// activate fires into a refused run rather than the other way round.
func Activate(ctx context.Context, store Store, params ActivationParams) (automationrepo.Automation, []automationrepo.Event, error) {
	item := params.Automation
	if item.Status == automationrepo.StatusActive {
		return item, nil, nil
	}
	definition, findings := automation.ParseDefinition(item.Definition)
	if len(findings) > 0 {
		return automationrepo.Automation{}, nil, &DefinitionInvalidError{Fields: prefixDefinition(findings)}
	}
	report := automation.ValidateDefinition(definition, automation.ValidateOptions{Catalog: params.Catalog, RequireConnections: true})
	if !report.Valid() {
		var missing []string
		var other []automation.FieldError
		for _, finding := range report.Errors {
			if finding.Code == "CONNECTION_MISSING" {
				missing = append(missing, providerAt(definition, finding.Path))
				continue
			}
			other = append(other, finding)
		}
		if len(other) > 0 {
			return automationrepo.Automation{}, nil, &DefinitionInvalidError{Fields: prefixDefinition(other)}
		}
		sort.Strings(missing)
		return automationrepo.Automation{}, nil, &ConnectionsMissingError{Providers: unique(missing)}
	}
	if item.Risk == automation.RiskHigh && !params.Role.Allows(identity.PermissionSettingsWrite) {
		return automationrepo.Automation{}, nil, ErrHighRisk
	}
	if item.Engine == automationrepo.EngineActivepieces {
		engine := params.Engine
		if engine == nil {
			engine = automation.NoopEngine{}
		}
		if _, err := engine.EnsureFlow(ctx, automation.FlowSpec{AutomationID: item.ID, WorkspaceID: item.WorkspaceID, Name: item.Name, Version: item.Version, Definition: definition}); err != nil {
			return automationrepo.Automation{}, nil, err
		}
	}
	if definition.Trigger.Type == automation.TriggerSchedule && params.Schedules != nil {
		spec := automationrun.ScheduleSpec{}
		if definition.Trigger.Config != nil {
			spec = automationrun.ScheduleSpec{Cron: definition.Trigger.Config.Cron, Timezone: definition.Trigger.Config.Timezone}
		}
		if err := params.Schedules.Ensure(ctx, item.ID, spec); err != nil {
			return automationrepo.Automation{}, nil, fmt.Errorf("register workflow schedule: %w", err)
		}
	}
	activated, event, err := store.SetStatus(ctx, item.ID, automationrepo.StatusActive, params.ActorID, params.Now, params.NewID)
	if err != nil {
		return automationrepo.Automation{}, nil, err
	}
	return activated, []automationrepo.Event{event}, nil
}

// providerAt reads the provider a CONNECTION_MISSING finding points at.
func providerAt(definition automation.Definition, path string) string {
	if path == "/trigger/provider" {
		return definition.Trigger.Provider
	}
	rest, ok := strings.CutPrefix(path, "/steps/")
	if !ok {
		return ""
	}
	index, _, _ := strings.Cut(rest, "/")
	position, err := strconv.Atoi(index)
	if err != nil || position < 0 || position >= len(definition.Steps) || definition.Steps[position].Action == nil {
		return ""
	}
	return definition.Steps[position].Action.Provider
}

func unique(values []string) []string {
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func (handler *handler) activate(response http.ResponseWriter, request *http.Request) {
	item, scope, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	catalog := handler.catalog(request.Context(), item.WorkspaceID)
	activated, events, err := Activate(request.Context(), handler.options.Store, ActivationParams{
		Automation: item, Role: scope.Role, ActorID: user.ID, Catalog: catalog, Engine: handler.options.Engine,
		Schedules: handler.options.Schedules, Now: handler.options.Clock().UTC(), NewID: handler.options.NewID,
	})
	if err != nil {
		WriteActivationError(response, request, err)
		return
	}
	shared.PublishLedger(request.Context(), handler.options.Broadcaster, events)
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), activated, catalog, true))
}

// WriteActivationError maps Activate's refusals to the contract.
func WriteActivationError(response http.ResponseWriter, request *http.Request, err error) {
	var missing *ConnectionsMissingError
	var invalid *DefinitionInvalidError
	switch {
	case errors.As(err, &missing):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "CONNECTIONS_MISSING",
			"Connect the providers this workflow uses before activating it.", map[string]any{"providers": missing.Providers})
	case errors.As(err, &invalid):
		writeDefinitionInvalid(response, request, invalid.Fields)
	case errors.Is(err, ErrHighRisk):
		httpapi.WriteError(response, request, http.StatusForbidden, "FORBIDDEN",
			"Activating a workflow with destructive actions needs an administrator.", map[string]string{"reason": "destructive_actions"})
	case errors.Is(err, automation.ErrEngineDisabled):
		httpapi.WriteError(response, request, http.StatusConflict, "WORKFLOW_ENGINE_DISABLED",
			"This workflow needs the external workflow engine, which is not enabled.", nil)
	case errors.Is(err, automationrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, "Workflow")
	default:
		workmanagement.WriteInternal(response, request)
	}
}

func (handler *handler) pause(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionWrite)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	paused, event, err := handler.options.Store.SetStatus(request.Context(), item.ID, automationrepo.StatusPaused, user.ID, handler.options.Clock().UTC(), handler.options.NewID)
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	if event.ID != uuid.Nil {
		shared.PublishLedger(request.Context(), handler.options.Broadcaster, []automationrepo.Event{event})
	}
	// Best effort, after the status: a paused row already refuses runs, so
	// a schedule that fires before this lands creates nothing.
	if item.Trigger.Type == automation.TriggerSchedule {
		if err := handler.options.Schedules.Pause(context.WithoutCancel(request.Context()), item.ID); err != nil {
			handler.options.Logger.Warn("workflow schedule not paused", "workflowId", item.ID, "error", err)
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, handler.serialize(request.Context(), paused, handler.catalog(request.Context(), item.WorkspaceID), true))
}

type runBody struct {
	Input json.RawMessage `json:"input"`
}

// run starts a workflow by hand. Any trigger type may be run this way; the
// body's input becomes trigger.input in the run's scope. The run row is
// durable before the starter sees it, so a starter that refuses the handoff
// leaves a pending run for reconciliation rather than losing the request.
func (handler *handler) run(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionRunsDispatch)
	if !ok {
		return
	}
	body, _, ok := workmanagement.DecodeJSON[runBody](response, request)
	if !ok {
		return
	}
	if handler.options.Starter == nil {
		httpapi.WriteError(response, request, http.StatusPreconditionFailed, "WORKFLOWS_DISABLED",
			"Workflow execution is disabled on this deployment.", nil)
		return
	}
	if item.Status != automationrepo.StatusActive {
		handler.writeError(response, request, automationrepo.ErrNotActive)
		return
	}
	input := body.Input
	if len(input) == 0 {
		input = json.RawMessage(`null`)
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"input": input})
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	user := auth.MustUser(request.Context())
	runID := handler.options.NewID()
	run, created, err := handler.options.Store.CreateRun(request.Context(), automationrepo.CreateRunParams{
		ID: runID, AutomationID: item.ID, TriggerType: automation.TriggerManual, Payload: payload,
		RequestedBy: &user.ID, RequestID: "manual:" + runID.String(), CreatedAt: handler.options.Clock().UTC(),
	})
	if err != nil {
		handler.writeError(response, request, err)
		return
	}
	if created {
		if err := handler.options.Starter.Start(context.WithoutCancel(request.Context()), run.ID); err != nil {
			handler.options.Logger.Error("manual workflow run not started", "runId", run.ID, "workflowId", item.ID, "error", err)
		}
	}
	response.Header().Set("Location", "/api/v1/workflow-runs/"+run.ID.String())
	httpapi.WriteJSON(response, http.StatusAccepted, automationruns.SerializeRun(run, nil))
}

func (handler *handler) listRuns(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	page, ok := workmanagement.ParsePage(response, request, "status")
	if !ok {
		return
	}
	filter := automationrepo.RunListFilter{WorkspaceID: item.WorkspaceID, AutomationID: &item.ID}
	if status := request.URL.Query().Get("status"); status != "" {
		if !automationruns.ValidStatus(status) {
			workmanagement.WriteInvalidQuery(response, request, "/query/status", "status is not a run status.")
			return
		}
		filter.Status = automationrepo.RunStatus(status)
	}
	scope := workmanagement.CursorScope("workflow.runs", item.ID.String(), string(filter.Status))
	var after *automationrepo.RunCursor
	if page.After != "" {
		var cursor automationrepo.RunCursor
		if httpapi.DecodeCursor(page.After, scope, &cursor) != nil || cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	runs, err := handler.options.Store.ListRuns(request.Context(), filter, after, page.First+1)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	hasNext := len(runs) > page.First
	if hasNext {
		runs = runs[:page.First]
	}
	nodes := make([]automationruns.RunResource, 0, len(runs))
	for _, run := range runs {
		nodes = append(nodes, automationruns.SerializeRun(run, nil))
	}
	var endCursor *string
	if len(runs) > 0 {
		last := runs[len(runs)-1]
		encoded, err := httpapi.EncodeCursor(scope, automationrepo.RunCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes, "pageInfo": workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: endCursor}})
}

type versionResource struct {
	ID         uuid.UUID       `json:"id"`
	Version    int             `json:"version"`
	Definition json.RawMessage `json:"definition"`
	CreatedBy  *uuid.UUID      `json:"createdBy"`
	CreatedAt  string          `json:"createdAt"`
}

func (handler *handler) listVersions(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionRead)
	if !ok {
		return
	}
	versions, err := handler.options.Store.ListVersions(request.Context(), item.ID)
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	nodes := make([]versionResource, 0, len(versions))
	for _, version := range versions {
		nodes = append(nodes, versionResource{ID: version.ID, Version: version.Version, Definition: version.Definition, CreatedBy: version.CreatedBy,
			CreatedAt: version.CreatedAt.UTC().Format(time.RFC3339Nano)})
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
}

// rotateWebhook mints a new hook token and returns it once. Only its digest
// is stored; the hooks mount that receives deliveries lands with execution.
func (handler *handler) rotateWebhook(response http.ResponseWriter, request *http.Request) {
	item, _, ok := handler.authorize(response, request, identity.PermissionSettingsWrite)
	if !ok {
		return
	}
	raw := make([]byte, 32)
	if _, err := io.ReadFull(handler.options.Random, raw); err != nil {
		workmanagement.WriteInternal(response, request)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err := handler.options.Store.RotateWebhookSecret(request.Context(), item.ID, token, handler.options.Clock().UTC()); err != nil {
		handler.writeError(response, request, err)
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]string{
		"url":    "/api/v1/hooks/workflows/" + item.ID.String() + "/" + token,
		"secret": token,
	})
}

func (handler *handler) writeError(response http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, automationrepo.ErrNotFound):
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity, "VALIDATION_FAILED", "The request is invalid.",
			httpapi.ValidationDetails{Fields: []httpapi.FieldError{{Path: "/", Code: "not_found", Message: "The workflow, goal or project does not exist in this workspace."}}})
	case errors.Is(err, automationrepo.ErrRevisionConflict):
		httpapi.WriteError(response, request, http.StatusConflict, "REVISION_CONFLICT", "The workflow was modified by another request; reload and retry.", nil)
	case errors.Is(err, automationrepo.ErrActive):
		httpapi.WriteError(response, request, http.StatusConflict, "WORKFLOW_ACTIVE", "Pause the workflow before changing its definition.", nil)
	case errors.Is(err, automationrepo.ErrInvalidTransition):
		httpapi.WriteError(response, request, http.StatusConflict, "WORKFLOW_NOT_ACTIVE", "Only an active workflow can be paused.", nil)
	case errors.Is(err, automationrepo.ErrNotActive):
		httpapi.WriteError(response, request, http.StatusConflict, "WORKFLOW_NOT_ACTIVE", "Only an active workflow can run; activate it first.", nil)
	case errors.Is(err, automationrepo.ErrConflict):
		httpapi.WriteError(response, request, http.StatusConflict, "CONFLICT", "The workflow could not be written because its state conflicts.", nil)
	default:
		workmanagement.WriteInternal(response, request)
	}
}

// Mounts follows the shared registry convention and fails fast on invalid wiring.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic("construct workflow handlers: " + err.Error())
	}
	return []httpapi.Mount{mount}
}
