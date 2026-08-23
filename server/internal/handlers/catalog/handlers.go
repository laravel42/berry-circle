// Package catalog exports the authenticated /api/v1/catalogs mount.
package catalog

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	catalogrepo "github.com/laravel42/berry-circle/server/internal/repository/catalogs"
)

// API is the HTTP-facing catalog service contract.
type API interface {
	ListLabels(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.ListFilter,
		*catalogrepo.TimeCursor,
		int,
	) ([]catalogrepo.Label, error)
	GetLabel(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (catalogrepo.Label, error)
	CreateLabel(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.CreateLabelParams,
	) (catalogrepo.Label, error)
	UpdateLabel(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.LabelPatch,
	) (catalogrepo.Label, error)
	DeleteLabel(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error

	ListStatuses(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.ListFilter,
		*catalogrepo.PositionCursor,
		int,
	) ([]catalogrepo.StatusDefinition, error)
	GetStatus(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.StatusDefinition, error)
	CreateStatus(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.CreateStatusParams,
	) (catalogrepo.StatusDefinition, error)
	UpdateStatus(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.StatusPatch,
	) (catalogrepo.StatusDefinition, error)
	DeleteStatus(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	ReorderStatuses(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) error

	ListProperties(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.ListFilter,
		*catalogrepo.PositionCursor,
		int,
	) ([]catalogrepo.PropertyDefinition, error)
	GetProperty(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.PropertyDefinition, error)
	CreateProperty(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.CreatePropertyParams,
	) (catalogrepo.PropertyDefinition, error)
	UpdateProperty(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.PropertyPatch,
	) (catalogrepo.PropertyDefinition, error)
	DeleteProperty(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error

	ListQuickActions(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.ListFilter,
		*catalogrepo.TimeCursor,
		int,
	) ([]catalogrepo.QuickAction, error)
	GetQuickAction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.QuickAction, error)
	CreateQuickAction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.CreateQuickActionParams,
	) (catalogrepo.QuickAction, error)
	UpdateQuickAction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		catalogrepo.QuickActionPatch,
	) (catalogrepo.QuickAction, error)
	DeleteQuickAction(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	RenderQuickAction(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.QuickActionRender, error)
	AuthorizeQuickActionRun(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.QuickActionRender, error)
	PrepareQuickActionInvocation(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
	) (catalogrepo.QuickActionInvocation, error)
}

// QuickActionRunner is the future server-side OpenFang adapter seam. This lane
// intentionally provides no implementation.
type QuickActionRunner interface {
	RunQuickAction(
		context.Context,
		catalogrepo.QuickActionInvocation,
	) (catalogrepo.QuickActionRun, error)
}

// Options are explicit mount dependencies. Runner is nil in P2 production
// wiring, which makes run return CAPABILITY_NOT_IMPLEMENTED after authorization.
type Options struct {
	Pool             *pgxpool.Pool
	Sessions         auth.SessionResolver
	Authorization    catalogrepo.Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Service          API
	Runner           QuickActionRunner
}

type handlers struct {
	service API
	runner  QuickActionRunner
}

// NewMount builds the disjoint catalog subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("catalog handler session resolver is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("catalog handler clock is nil")
	}
	if options.IdempotencyStore == nil {
		return httpapi.Mount{}, errors.New("catalog handler idempotency store is nil")
	}
	service := options.Service
	if service == nil {
		if options.Authorization == nil {
			return httpapi.Mount{}, errors.New("catalog handler authorizer is nil")
		}
		if options.NewID == nil {
			return httpapi.Mount{}, errors.New("catalog handler ID generator is nil")
		}
		repository, err := catalogrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		built, err := catalogrepo.NewService(catalogrepo.ServiceOptions{
			Store:         repository,
			Authorization: options.Authorization,
			Clock:         options.Clock,
			NewID:         options.NewID,
		})
		if err != nil {
			return httpapi.Mount{}, err
		}
		service = built
	}
	target := &handlers{service: service, runner: options.Runner}
	idempotent := func(next http.HandlerFunc) http.HandlerFunc {
		return workmanagement.RequireIdempotency(
			options.IdempotencyStore,
			options.Clock,
			next,
		).ServeHTTP
	}

	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/{workspaceId}/issue-labels", target.listLabels)
	router.Post("/{workspaceId}/issue-labels", idempotent(target.createLabel))
	router.Get("/{workspaceId}/issue-labels/{labelId}", target.getLabel)
	router.Patch("/{workspaceId}/issue-labels/{labelId}", target.updateLabel)
	router.Delete("/{workspaceId}/issue-labels/{labelId}", target.deleteLabel)

	router.Get("/{workspaceId}/issue-statuses", target.listStatuses)
	router.Post("/{workspaceId}/issue-statuses", idempotent(target.createStatus))
	router.Patch("/{workspaceId}/issue-statuses/order", target.reorderStatuses)
	router.Get("/{workspaceId}/issue-statuses/{statusId}", target.getStatus)
	router.Patch("/{workspaceId}/issue-statuses/{statusId}", target.updateStatus)
	router.Delete("/{workspaceId}/issue-statuses/{statusId}", target.deleteStatus)

	router.Get("/{workspaceId}/properties", target.listProperties)
	router.Post("/{workspaceId}/properties", idempotent(target.createProperty))
	router.Get("/{workspaceId}/properties/{propertyId}", target.getProperty)
	router.Patch("/{workspaceId}/properties/{propertyId}", target.updateProperty)
	router.Delete("/{workspaceId}/properties/{propertyId}", target.deleteProperty)

	router.Get("/{workspaceId}/quick-actions", target.listQuickActions)
	router.Post("/{workspaceId}/quick-actions", idempotent(target.createQuickAction))
	router.Get("/{workspaceId}/quick-actions/{actionId}", target.getQuickAction)
	router.Patch("/{workspaceId}/quick-actions/{actionId}", target.updateQuickAction)
	router.Delete("/{workspaceId}/quick-actions/{actionId}", target.deleteQuickAction)
	router.Post("/{workspaceId}/quick-actions/{actionId}/render", target.renderQuickAction)
	router.Post(
		"/{workspaceId}/quick-actions/{actionId}/run",
		idempotent(target.runQuickAction),
	)
	return httpapi.Mount{Prefix: "/api/v1/catalogs", Handler: router}, nil
}

// Mounts follows the shared registry fail-fast convention.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct catalog handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type labelResource struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspaceId"`
	Name        string    `json:"name"`
	Description *string   `json:"description"`
	Color       string    `json:"color"`
	CreatedAt   string    `json:"createdAt"`
	UpdatedAt   string    `json:"updatedAt"`
	ArchivedAt  *string   `json:"archivedAt"`
}

type labelConnection struct {
	Nodes    []labelResource         `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

type statusResource struct {
	ID          uuid.UUID                    `json:"id"`
	WorkspaceID uuid.UUID                    `json:"workspaceId"`
	Key         string                       `json:"key"`
	Name        string                       `json:"name"`
	Description *string                      `json:"description"`
	Category    catalogrepo.WorkflowCategory `json:"category"`
	Color       string                       `json:"color"`
	SortOrder   int                          `json:"sortOrder"`
	IsSystem    bool                         `json:"isSystem"`
	CreatedAt   string                       `json:"createdAt"`
	UpdatedAt   string                       `json:"updatedAt"`
	ArchivedAt  *string                      `json:"archivedAt"`
}

type statusConnection struct {
	Nodes    []statusResource        `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

type propertyResource struct {
	ID          uuid.UUID                  `json:"id"`
	WorkspaceID uuid.UUID                  `json:"workspaceId"`
	Name        string                     `json:"name"`
	Description *string                    `json:"description"`
	Kind        catalogrepo.PropertyKind   `json:"kind"`
	Config      catalogrepo.PropertyConfig `json:"config"`
	Icon        *string                    `json:"icon"`
	SortOrder   int                        `json:"sortOrder"`
	CreatedAt   string                     `json:"createdAt"`
	UpdatedAt   string                     `json:"updatedAt"`
	ArchivedAt  *string                    `json:"archivedAt"`
}

type propertyConnection struct {
	Nodes    []propertyResource      `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

type quickActionResource struct {
	ID            uuid.UUID                         `json:"id"`
	WorkspaceID   uuid.UUID                         `json:"workspaceId"`
	Name          string                            `json:"name"`
	Description   *string                           `json:"description"`
	TargetAgentID uuid.UUID                         `json:"targetAgentId"`
	Visibility    catalogrepo.QuickActionVisibility `json:"visibility"`
	CreatedBy     uuid.UUID                         `json:"createdBy"`
	CreatedAt     string                            `json:"createdAt"`
	UpdatedAt     string                            `json:"updatedAt"`
	ArchivedAt    *string                           `json:"archivedAt"`
}

type quickActionConnection struct {
	Nodes    []quickActionResource   `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

type quickActionRenderResource struct {
	ActionID      uuid.UUID `json:"actionId"`
	IssueID       uuid.UUID `json:"issueId"`
	Name          string    `json:"name"`
	Description   *string   `json:"description"`
	TargetAgentID uuid.UUID `json:"targetAgentId"`
	Ready         bool      `json:"ready"`
	Capability    string    `json:"capability"`
}

type quickActionRunResource struct {
	RunID    uuid.UUID `json:"runId"`
	Accepted bool      `json:"accepted"`
}

type capabilityDetails struct {
	Capability string `json:"capability"`
}

func (handler *handlers) listLabels(response http.ResponseWriter, request *http.Request) {
	workspaceID, filter, page, scope, ok := parseCatalogList(
		response,
		request,
		"catalog.labels",
	)
	if !ok {
		return
	}
	after, ok := decodeTimeCursor(response, request, page.After, scope)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.ListLabels(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		after,
		page.First+1,
	)
	if !writeCatalogError(response, request, err, "Issue label") {
		return
	}
	nodes, info, ok := pageLabels(response, request, rows, page.First, scope)
	if !ok {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, labelConnection{Nodes: nodes, PageInfo: info})
}

func (handler *handlers) getLabel(response http.ResponseWriter, request *http.Request) {
	workspaceID, labelID, ok := parseCatalogIDs(
		response,
		request,
		"labelId",
		"Issue label",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	label, err := handler.service.GetLabel(request.Context(), user.ID, workspaceID, labelID)
	if !writeCatalogError(response, request, err, "Issue label") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeLabel(label))
}

func (handler *handlers) createLabel(response http.ResponseWriter, request *http.Request) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return
	}
	input, ok := parseCreateLabel(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	label, err := handler.service.CreateLabel(request.Context(), user.ID, workspaceID, input)
	if !writeCatalogError(response, request, err, "Issue label") {
		return
	}
	response.Header().Set(
		"Location",
		"/api/v1/catalogs/"+workspaceID.String()+"/issue-labels/"+label.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, serializeLabel(label))
}

func (handler *handlers) updateLabel(response http.ResponseWriter, request *http.Request) {
	workspaceID, labelID, ok := parseCatalogIDs(
		response,
		request,
		"labelId",
		"Issue label",
	)
	if !ok {
		return
	}
	patch, ok := parseLabelPatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	label, err := handler.service.UpdateLabel(
		request.Context(),
		user.ID,
		workspaceID,
		labelID,
		patch,
	)
	if !writeCatalogError(response, request, err, "Issue label") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeLabel(label))
}

func (handler *handlers) deleteLabel(response http.ResponseWriter, request *http.Request) {
	workspaceID, labelID, ok := parseCatalogIDs(
		response,
		request,
		"labelId",
		"Issue label",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.DeleteLabel(request.Context(), user.ID, workspaceID, labelID)
	if !writeCatalogError(response, request, err, "Issue label") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) listStatuses(response http.ResponseWriter, request *http.Request) {
	workspaceID, filter, page, scope, ok := parseCatalogList(
		response,
		request,
		"catalog.statuses",
	)
	if !ok {
		return
	}
	after, ok := decodePositionCursor(response, request, page.After, scope)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.ListStatuses(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		after,
		page.First+1,
	)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	nodes, info, ok := pageStatuses(response, request, rows, page.First, scope)
	if !ok {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, statusConnection{Nodes: nodes, PageInfo: info})
}

func (handler *handlers) getStatus(response http.ResponseWriter, request *http.Request) {
	workspaceID, statusID, ok := parseCatalogIDs(
		response,
		request,
		"statusId",
		"Issue status",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	status, err := handler.service.GetStatus(request.Context(), user.ID, workspaceID, statusID)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeStatus(status))
}

func (handler *handlers) createStatus(response http.ResponseWriter, request *http.Request) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return
	}
	input, ok := parseCreateStatus(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	status, err := handler.service.CreateStatus(request.Context(), user.ID, workspaceID, input)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	response.Header().Set(
		"Location",
		"/api/v1/catalogs/"+workspaceID.String()+"/issue-statuses/"+status.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, serializeStatus(status))
}

func (handler *handlers) updateStatus(response http.ResponseWriter, request *http.Request) {
	workspaceID, statusID, ok := parseCatalogIDs(
		response,
		request,
		"statusId",
		"Issue status",
	)
	if !ok {
		return
	}
	patch, ok := parseStatusPatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	status, err := handler.service.UpdateStatus(
		request.Context(),
		user.ID,
		workspaceID,
		statusID,
		patch,
	)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeStatus(status))
}

func (handler *handlers) deleteStatus(response http.ResponseWriter, request *http.Request) {
	workspaceID, statusID, ok := parseCatalogIDs(
		response,
		request,
		"statusId",
		"Issue status",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.DeleteStatus(request.Context(), user.ID, workspaceID, statusID)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) reorderStatuses(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return
	}
	statusIDs, ok := parseStatusOrder(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.ReorderStatuses(request.Context(), user.ID, workspaceID, statusIDs)
	if !writeCatalogError(response, request, err, "Issue status") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) listProperties(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, filter, page, scope, ok := parseCatalogList(
		response,
		request,
		"catalog.properties",
	)
	if !ok {
		return
	}
	after, ok := decodePositionCursor(response, request, page.After, scope)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.ListProperties(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		after,
		page.First+1,
	)
	if !writeCatalogError(response, request, err, "Property") {
		return
	}
	nodes, info, ok := pageProperties(response, request, rows, page.First, scope)
	if !ok {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, propertyConnection{Nodes: nodes, PageInfo: info})
}

func (handler *handlers) getProperty(response http.ResponseWriter, request *http.Request) {
	workspaceID, propertyID, ok := parseCatalogIDs(
		response,
		request,
		"propertyId",
		"Property",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	property, err := handler.service.GetProperty(
		request.Context(),
		user.ID,
		workspaceID,
		propertyID,
	)
	if !writeCatalogError(response, request, err, "Property") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProperty(property))
}

func (handler *handlers) createProperty(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return
	}
	input, ok := parseCreateProperty(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	property, err := handler.service.CreateProperty(
		request.Context(),
		user.ID,
		workspaceID,
		input,
	)
	if !writeCatalogError(response, request, err, "Property") {
		return
	}
	response.Header().Set(
		"Location",
		"/api/v1/catalogs/"+workspaceID.String()+"/properties/"+property.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, serializeProperty(property))
}

func (handler *handlers) updateProperty(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, propertyID, ok := parseCatalogIDs(
		response,
		request,
		"propertyId",
		"Property",
	)
	if !ok {
		return
	}
	patch, ok := parsePropertyPatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	property, err := handler.service.UpdateProperty(
		request.Context(),
		user.ID,
		workspaceID,
		propertyID,
		patch,
	)
	if !writeCatalogError(response, request, err, "Property") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProperty(property))
}

func (handler *handlers) deleteProperty(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, propertyID, ok := parseCatalogIDs(
		response,
		request,
		"propertyId",
		"Property",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.DeleteProperty(request.Context(), user.ID, workspaceID, propertyID)
	if !writeCatalogError(response, request, err, "Property") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) listQuickActions(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, filter, page, scope, ok := parseCatalogList(
		response,
		request,
		"catalog.quick-actions",
	)
	if !ok {
		return
	}
	after, ok := decodeTimeCursor(response, request, page.After, scope)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.ListQuickActions(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		after,
		page.First+1,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	nodes, info, ok := pageQuickActions(response, request, rows, page.First, scope)
	if !ok {
		return
	}
	httpapi.WriteJSON(
		response,
		http.StatusOK,
		quickActionConnection{Nodes: nodes, PageInfo: info},
	)
}

func (handler *handlers) getQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, actionID, ok := parseCatalogIDs(
		response,
		request,
		"actionId",
		"Quick action",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	action, err := handler.service.GetQuickAction(
		request.Context(),
		user.ID,
		workspaceID,
		actionID,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeQuickAction(action))
}

func (handler *handlers) createQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return
	}
	input, ok := parseCreateQuickAction(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	action, err := handler.service.CreateQuickAction(
		request.Context(),
		user.ID,
		workspaceID,
		input,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	response.Header().Set(
		"Location",
		"/api/v1/catalogs/"+workspaceID.String()+"/quick-actions/"+action.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, serializeQuickAction(action))
}

func (handler *handlers) updateQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, actionID, ok := parseCatalogIDs(
		response,
		request,
		"actionId",
		"Quick action",
	)
	if !ok {
		return
	}
	patch, ok := parseQuickActionPatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	action, err := handler.service.UpdateQuickAction(
		request.Context(),
		user.ID,
		workspaceID,
		actionID,
		patch,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeQuickAction(action))
}

func (handler *handlers) deleteQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, actionID, ok := parseCatalogIDs(
		response,
		request,
		"actionId",
		"Quick action",
	)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.DeleteQuickAction(request.Context(), user.ID, workspaceID, actionID)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) renderQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, actionID, ok := parseCatalogIDs(
		response,
		request,
		"actionId",
		"Quick action",
	)
	if !ok {
		return
	}
	issueID, ok := parseQuickActionIssue(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	rendered, err := handler.service.RenderQuickAction(
		request.Context(),
		user.ID,
		workspaceID,
		issueID,
		actionID,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeRender(rendered, handler.runner != nil))
}

func (handler *handlers) runQuickAction(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, actionID, ok := parseCatalogIDs(
		response,
		request,
		"actionId",
		"Quick action",
	)
	if !ok {
		return
	}
	issueID, ok := parseQuickActionIssue(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if handler.runner == nil {
		if _, err := handler.service.AuthorizeQuickActionRun(
			request.Context(),
			user.ID,
			workspaceID,
			issueID,
			actionID,
		); !writeCatalogError(response, request, err, "Quick action") {
			return
		}
		httpapi.WriteError(
			response,
			request,
			http.StatusNotImplemented,
			"CAPABILITY_NOT_IMPLEMENTED",
			"Quick-action execution is not available.",
			capabilityDetails{Capability: "quickAction.run"},
		)
		return
	}
	invocation, err := handler.service.PrepareQuickActionInvocation(
		request.Context(),
		user.ID,
		workspaceID,
		issueID,
		actionID,
	)
	if !writeCatalogError(response, request, err, "Quick action") {
		return
	}
	result, err := handler.runner.RunQuickAction(request.Context(), invocation)
	if err != nil {
		httpapi.WriteError(
			response,
			request,
			http.StatusServiceUnavailable,
			"CAPABILITY_UNAVAILABLE",
			"Quick-action execution is temporarily unavailable.",
			capabilityDetails{Capability: "quickAction.run"},
		)
		return
	}
	httpapi.WriteJSON(response, http.StatusAccepted, quickActionRunResource{
		RunID:    result.RunID,
		Accepted: result.Accepted,
	})
}

func parseCatalogList(
	response http.ResponseWriter,
	request *http.Request,
	baseScope string,
) (uuid.UUID, catalogrepo.ListFilter, workmanagement.Page, string, bool) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return uuid.Nil, catalogrepo.ListFilter{}, workmanagement.Page{}, "", false
	}
	page, ok := workmanagement.ParsePage(response, request, "query", "includeArchived")
	if !ok {
		return uuid.Nil, catalogrepo.ListFilter{}, workmanagement.Page{}, "", false
	}
	filter := catalogrepo.ListFilter{}
	if raw, supplied := request.URL.Query()["query"]; supplied {
		filter.Query = strings.TrimSpace(raw[0])
		length := utf8.RuneCountInString(filter.Query)
		if length < 1 || length > 200 {
			workmanagement.WriteInvalidQuery(
				response,
				request,
				"/query/query",
				"query must contain 1 to 200 characters.",
			)
			return uuid.Nil, catalogrepo.ListFilter{}, workmanagement.Page{}, "", false
		}
	}
	if raw, supplied := request.URL.Query()["includeArchived"]; supplied {
		parsed, err := strconv.ParseBool(raw[0])
		if err != nil || (raw[0] != "true" && raw[0] != "false") {
			workmanagement.WriteInvalidQuery(
				response,
				request,
				"/query/includeArchived",
				"includeArchived must be true or false.",
			)
			return uuid.Nil, catalogrepo.ListFilter{}, workmanagement.Page{}, "", false
		}
		filter.IncludeArchived = parsed
	}
	scope := workmanagement.CursorScope(
		baseScope,
		workspaceID.String(),
		filter.Query,
		strconv.FormatBool(filter.IncludeArchived),
	)
	return workspaceID, filter, page, scope, true
}

func parseWorkspaceID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	id, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, "workspaceId"))
	if !ok {
		workmanagement.WriteNotFound(response, request, "Workspace")
		return uuid.Nil, false
	}
	return id, true
}

func parseCatalogIDs(
	response http.ResponseWriter,
	request *http.Request,
	idParameter, resource string,
) (uuid.UUID, uuid.UUID, bool) {
	workspaceID, ok := parseWorkspaceID(response, request)
	if !ok {
		return uuid.Nil, uuid.Nil, false
	}
	resourceID, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, idParameter))
	if !ok {
		workmanagement.WriteNotFound(response, request, resource)
		return uuid.Nil, uuid.Nil, false
	}
	return workspaceID, resourceID, true
}

func decodeTimeCursor(
	response http.ResponseWriter,
	request *http.Request,
	encoded, scope string,
) (*catalogrepo.TimeCursor, bool) {
	if encoded == "" {
		return nil, true
	}
	var cursor catalogrepo.TimeCursor
	if err := httpapi.DecodeCursor(encoded, scope, &cursor); err != nil ||
		cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
		workmanagement.WriteInvalidCursor(response, request)
		return nil, false
	}
	return &cursor, true
}

func decodePositionCursor(
	response http.ResponseWriter,
	request *http.Request,
	encoded, scope string,
) (*catalogrepo.PositionCursor, bool) {
	if encoded == "" {
		return nil, true
	}
	var cursor catalogrepo.PositionCursor
	if err := httpapi.DecodeCursor(encoded, scope, &cursor); err != nil ||
		cursor.ID == uuid.Nil || cursor.SortOrder < 0 {
		workmanagement.WriteInvalidCursor(response, request)
		return nil, false
	}
	return &cursor, true
}

func pageLabels(
	response http.ResponseWriter,
	request *http.Request,
	rows []catalogrepo.Label,
	first int,
	scope string,
) ([]labelResource, workmanagement.PageInfo, bool) {
	hasNext := len(rows) > first
	if hasNext {
		rows = rows[:first]
	}
	nodes := make([]labelResource, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, serializeLabel(row))
	}
	end, ok := encodeTimeEnd(response, request, scope, len(rows), func() catalogrepo.TimeCursor {
		last := rows[len(rows)-1]
		return catalogrepo.TimeCursor{UpdatedAt: last.UpdatedAt, ID: last.ID}
	})
	return nodes, workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: end}, ok
}

func pageStatuses(
	response http.ResponseWriter,
	request *http.Request,
	rows []catalogrepo.StatusDefinition,
	first int,
	scope string,
) ([]statusResource, workmanagement.PageInfo, bool) {
	hasNext := len(rows) > first
	if hasNext {
		rows = rows[:first]
	}
	nodes := make([]statusResource, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, serializeStatus(row))
	}
	end, ok := encodePositionEnd(
		response,
		request,
		scope,
		len(rows),
		func() catalogrepo.PositionCursor {
			last := rows[len(rows)-1]
			return catalogrepo.PositionCursor{SortOrder: last.SortOrder, ID: last.ID}
		},
	)
	return nodes, workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: end}, ok
}

func pageProperties(
	response http.ResponseWriter,
	request *http.Request,
	rows []catalogrepo.PropertyDefinition,
	first int,
	scope string,
) ([]propertyResource, workmanagement.PageInfo, bool) {
	hasNext := len(rows) > first
	if hasNext {
		rows = rows[:first]
	}
	nodes := make([]propertyResource, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, serializeProperty(row))
	}
	end, ok := encodePositionEnd(
		response,
		request,
		scope,
		len(rows),
		func() catalogrepo.PositionCursor {
			last := rows[len(rows)-1]
			return catalogrepo.PositionCursor{SortOrder: last.SortOrder, ID: last.ID}
		},
	)
	return nodes, workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: end}, ok
}

func pageQuickActions(
	response http.ResponseWriter,
	request *http.Request,
	rows []catalogrepo.QuickAction,
	first int,
	scope string,
) ([]quickActionResource, workmanagement.PageInfo, bool) {
	hasNext := len(rows) > first
	if hasNext {
		rows = rows[:first]
	}
	nodes := make([]quickActionResource, 0, len(rows))
	for _, row := range rows {
		nodes = append(nodes, serializeQuickAction(row))
	}
	end, ok := encodeTimeEnd(response, request, scope, len(rows), func() catalogrepo.TimeCursor {
		last := rows[len(rows)-1]
		return catalogrepo.TimeCursor{UpdatedAt: last.UpdatedAt, ID: last.ID}
	})
	return nodes, workmanagement.PageInfo{HasNextPage: hasNext, EndCursor: end}, ok
}

func encodeTimeEnd(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
	length int,
	cursor func() catalogrepo.TimeCursor,
) (*string, bool) {
	if length == 0 {
		return nil, true
	}
	encoded, err := httpapi.EncodeCursor(scope, cursor())
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return nil, false
	}
	return &encoded, true
}

func encodePositionEnd(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
	length int,
	cursor func() catalogrepo.PositionCursor,
) (*string, bool) {
	if length == 0 {
		return nil, true
	}
	encoded, err := httpapi.EncodeCursor(scope, cursor())
	if err != nil {
		workmanagement.WriteInternal(response, request)
		return nil, false
	}
	return &encoded, true
}

func writeCatalogError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound), errors.Is(err, catalogrepo.ErrNotFound):
		workmanagement.WriteNotFound(response, request, resource)
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	case errors.Is(err, catalogrepo.ErrSystemDefinition):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"SYSTEM_STATUS_IMMUTABLE",
			"System issue statuses cannot be archived.",
			nil,
		)
	case errors.Is(err, catalogrepo.ErrInvalidValue):
		workmanagement.WriteValidation(response, request, httpapi.FieldError{
			Path:    "/value",
			Code:    "invalid_value",
			Message: "Value does not match its definition.",
		})
	case errors.Is(err, catalogrepo.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The requested catalog change conflicts with existing data.",
			nil,
		)
	default:
		workmanagement.WriteInternal(response, request)
	}
	return false
}

func serializeLabel(label catalogrepo.Label) labelResource {
	return labelResource{
		ID:          label.ID,
		WorkspaceID: label.WorkspaceID,
		Name:        label.Name,
		Description: label.Description,
		Color:       label.Color,
		CreatedAt:   label.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   label.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ArchivedAt:  formatOptionalTime(label.ArchivedAt),
	}
}

func serializeStatus(status catalogrepo.StatusDefinition) statusResource {
	return statusResource{
		ID:          status.ID,
		WorkspaceID: status.WorkspaceID,
		Key:         status.Key,
		Name:        status.Name,
		Description: status.Description,
		Category:    status.Category,
		Color:       status.Color,
		SortOrder:   status.SortOrder,
		IsSystem:    status.IsSystem,
		CreatedAt:   status.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   status.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ArchivedAt:  formatOptionalTime(status.ArchivedAt),
	}
}

func serializeProperty(property catalogrepo.PropertyDefinition) propertyResource {
	return propertyResource{
		ID:          property.ID,
		WorkspaceID: property.WorkspaceID,
		Name:        property.Name,
		Description: property.Description,
		Kind:        property.Kind,
		Config:      property.Config,
		Icon:        property.Icon,
		SortOrder:   property.SortOrder,
		CreatedAt:   property.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   property.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ArchivedAt:  formatOptionalTime(property.ArchivedAt),
	}
}

func serializeQuickAction(action catalogrepo.QuickAction) quickActionResource {
	return quickActionResource{
		ID:            action.ID,
		WorkspaceID:   action.WorkspaceID,
		Name:          action.Name,
		Description:   action.Description,
		TargetAgentID: action.TargetAgentID,
		Visibility:    action.Visibility,
		CreatedBy:     action.CreatedBy,
		CreatedAt:     action.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:     action.UpdatedAt.UTC().Format(time.RFC3339Nano),
		ArchivedAt:    formatOptionalTime(action.ArchivedAt),
	}
}

func serializeRender(
	rendered catalogrepo.QuickActionRender,
	available bool,
) quickActionRenderResource {
	return quickActionRenderResource{
		ActionID:      rendered.ActionID,
		IssueID:       rendered.IssueID,
		Name:          rendered.Name,
		Description:   rendered.Description,
		TargetAgentID: rendered.TargetAgentID,
		Ready:         rendered.Ready && available,
		Capability:    "quickAction.run",
	}
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
