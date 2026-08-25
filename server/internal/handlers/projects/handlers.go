// Package projects exports the disjoint authenticated /api/v1/projects mount.
package projects

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
	"github.com/laravel42/berry-circle/server/internal/handlers/workmanagement"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	projectrepo "github.com/laravel42/berry-circle/server/internal/repository/projects"
)

// API is the HTTP-facing project service contract.
type API interface {
	List(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		projectrepo.ListFilter,
		*projectrepo.Cursor,
		int,
	) ([]projectrepo.Project, error)
	Create(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		projectrepo.CreateParams,
	) (projectrepo.Project, error)
	Get(context.Context, uuid.UUID, uuid.UUID) (projectrepo.Project, error)
	Update(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		projectrepo.Patch,
	) (projectrepo.Project, error)
	Delete(context.Context, uuid.UUID, uuid.UUID) error
	ListResources(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		*projectrepo.ResourceCursor,
		int,
	) ([]projectrepo.Resource, error)
	CreateResource(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		projectrepo.CreateResourceParams,
	) (projectrepo.Resource, error)
	UpdateResource(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		projectrepo.ResourcePatch,
	) (projectrepo.Resource, error)
	DeleteResource(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
}

// Options are explicit process dependencies. Service may be supplied by tests;
// production wiring normally lets the mount construct it from Pool.
type Options struct {
	Pool             *pgxpool.Pool
	Sessions         auth.SessionResolver
	Authorization    projectrepo.Authorizer
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Service          API
	// Repositories resolves a GitHub repository when a project is linked to
	// one. Optional: without it, linking is refused rather than stored half
	// resolved.
	Repositories RepositoryResolver
}

// RepositoryResolver turns a repository's full name into the id GitHub keeps
// stable across renames.
//
// The id is resolved rather than accepted from the client: a caller-supplied id
// could name a repository the connection cannot see, and the stored pair would
// then disagree about which repository the project delivers into.
type RepositoryResolver interface {
	ResolveRepository(ctx context.Context, workspaceID uuid.UUID, fullName string) (int64, error)
}

type handlers struct {
	service    API
	repository RepositoryResolver
}

// NewMount validates dependencies and builds the project subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("project handler session resolver is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("project handler clock is nil")
	}
	if options.IdempotencyStore == nil {
		return httpapi.Mount{}, errors.New("project handler idempotency store is nil")
	}
	service := options.Service
	if service == nil {
		if options.Authorization == nil {
			return httpapi.Mount{}, errors.New("project handler authorizer is nil")
		}
		if options.NewID == nil {
			return httpapi.Mount{}, errors.New("project handler ID generator is nil")
		}
		repository, err := projectrepo.New(options.Pool)
		if err != nil {
			return httpapi.Mount{}, err
		}
		built, err := projectrepo.NewService(projectrepo.ServiceOptions{
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
	target := &handlers{service: service, repository: options.Repositories}
	idempotent := func(next http.HandlerFunc) http.HandlerFunc {
		return workmanagement.RequireIdempotency(
			options.IdempotencyStore,
			options.Clock,
			next,
		).ServeHTTP
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", target.list)
	router.Post("/", idempotent(target.create))
	router.Get("/{projectId}", target.get)
	router.Patch("/{projectId}", target.update)
	router.Delete("/{projectId}", target.delete)
	router.Get("/{projectId}/resources", target.listResources)
	router.Post("/{projectId}/resources", idempotent(target.createResource))
	router.Patch("/{projectId}/resources/{resourceId}", target.updateResource)
	router.Delete("/{projectId}/resources/{resourceId}", target.deleteResource)
	return httpapi.Mount{Prefix: "/api/v1/projects", Handler: router}, nil
}

// Mounts follows the shared registry fail-fast convention.
func Mounts(options Options) []httpapi.Mount {
	mount, err := NewMount(options)
	if err != nil {
		panic(fmt.Sprintf("construct project handlers: %v", err))
	}
	return []httpapi.Mount{mount}
}

type projectResource struct {
	ID          uuid.UUID            `json:"id"`
	WorkspaceID uuid.UUID            `json:"workspaceId"`
	Name        string               `json:"name"`
	Description *string              `json:"description"`
	Status      projectrepo.Status   `json:"status"`
	Priority    projectrepo.Priority `json:"priority"`
	StartDate   *string              `json:"startDate"`
	TargetDate  *string              `json:"targetDate"`
	GitHubRepo  *string              `json:"githubRepo"`
	CreatedAt   string               `json:"createdAt"`
	UpdatedAt   string               `json:"updatedAt"`
}

type projectConnection struct {
	Nodes    []projectResource       `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

type resourceResource struct {
	ID          uuid.UUID                `json:"id"`
	ProjectID   uuid.UUID                `json:"projectId"`
	Kind        projectrepo.ResourceKind `json:"kind"`
	URL         string                   `json:"url"`
	Label       *string                  `json:"label"`
	Description *string                  `json:"description"`
	SortOrder   int                      `json:"sortOrder"`
	CreatedAt   string                   `json:"createdAt"`
	UpdatedAt   string                   `json:"updatedAt"`
}

type resourceConnection struct {
	Nodes    []resourceResource      `json:"nodes"`
	PageInfo workmanagement.PageInfo `json:"pageInfo"`
}

func (handler *handlers) list(response http.ResponseWriter, request *http.Request) {
	page, ok := workmanagement.ParsePage(
		response,
		request,
		"workspaceId",
		"query",
		"status",
		"priority",
	)
	if !ok {
		return
	}
	workspaceID, ok := parseQueryUUID(response, request, "workspaceId", true)
	if !ok {
		return
	}
	filter, ok := parseListFilter(response, request)
	if !ok {
		return
	}
	scope := workmanagement.CursorScope(
		"projects.list",
		workspaceID.String(),
		filter.Query,
		optionalStatus(filter.Status),
		optionalPriority(filter.Priority),
	)
	var after *projectrepo.Cursor
	if page.After != "" {
		var decoded projectrepo.Cursor
		if err := httpapi.DecodeCursor(page.After, scope, &decoded); err != nil ||
			decoded.ID == uuid.Nil || decoded.UpdatedAt.IsZero() {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &decoded
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.List(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		after,
		page.First+1,
	)
	if !writeServiceError(response, request, err, "Project") {
		return
	}
	hasNext := len(rows) > page.First
	if hasNext {
		rows = rows[:page.First]
	}
	nodes := make([]projectResource, 0, len(rows))
	for _, project := range rows {
		nodes = append(nodes, serializeProject(project))
	}
	var endCursor *string
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		encoded, err := httpapi.EncodeCursor(scope, projectrepo.Cursor{
			UpdatedAt: last.UpdatedAt,
			ID:        last.ID,
		})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, projectConnection{
		Nodes: nodes,
		PageInfo: workmanagement.PageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

// resolveRepository turns a full name into the id GitHub keeps stable, or
// refuses the request.
//
// Shared by create and update because both store the same pair under the same
// constraint: one path resolving and the other trusting the client is how the
// two columns end up disagreeing.
func (handler *handlers) resolveRepository(
	response http.ResponseWriter,
	request *http.Request,
	fullName string,
) (int64, bool) {
	if handler.repository == nil {
		httpapi.WriteError(response, request, http.StatusPreconditionFailed,
			"INTEGRATIONS_NOT_CONFIGURED",
			"This deployment cannot resolve GitHub repositories.", nil)
		return 0, false
	}
	user := auth.MustUser(request.Context())
	workspaceID := uuid.Nil
	if user.CurrentWorkspaceID != nil {
		workspaceID = *user.CurrentWorkspaceID
	}
	id, err := handler.repository.ResolveRepository(request.Context(), workspaceID, fullName)
	if err != nil {
		// Named rather than generic: the two ways this fails — no connection,
		// and a repository the connection cannot see — are both things a person
		// can fix, and neither is a server fault.
		httpapi.WriteError(response, request, http.StatusUnprocessableEntity,
			"REPOSITORY_UNAVAILABLE",
			"That repository could not be reached with the connected GitHub account.", nil)
		return 0, false
	}
	return id, true
}

func (handler *handlers) create(response http.ResponseWriter, request *http.Request) {
	workspaceID, input, ok := parseCreateProject(response, request)
	if !ok {
		return
	}
	if input.GitHubRepoFullName != nil {
		id, resolved := handler.resolveRepository(response, request, *input.GitHubRepoFullName)
		if !resolved {
			return
		}
		input.GitHubRepoID = &id
	}
	user := auth.MustUser(request.Context())
	project, err := handler.service.Create(request.Context(), user.ID, workspaceID, input)
	if !writeServiceError(response, request, err, "Project") {
		return
	}
	response.Header().Set("Location", "/api/v1/projects/"+project.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, serializeProject(project))
}

func (handler *handlers) get(response http.ResponseWriter, request *http.Request) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	project, err := handler.service.Get(request.Context(), user.ID, projectID)
	if !writeServiceError(response, request, err, "Project") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProject(project))
}

func (handler *handlers) update(response http.ResponseWriter, request *http.Request) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	patch, ok := parseProjectPatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if patch.GitHubRepoSet && patch.GitHubRepoFullName != nil {
		id, resolved := handler.resolveRepository(response, request, *patch.GitHubRepoFullName)
		if !resolved {
			return
		}
		patch.GitHubRepoID = &id
	}
	project, err := handler.service.Update(request.Context(), user.ID, projectID, patch)
	if !writeServiceError(response, request, err, "Project") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeProject(project))
}

func (handler *handlers) delete(response http.ResponseWriter, request *http.Request) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	if err := handler.service.Delete(request.Context(), user.ID, projectID); !writeServiceError(
		response,
		request,
		err,
		"Project",
	) {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handler *handlers) listResources(
	response http.ResponseWriter,
	request *http.Request,
) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	page, ok := workmanagement.ParsePage(response, request)
	if !ok {
		return
	}
	scope := workmanagement.CursorScope("projects.resources", projectID.String())
	var after *projectrepo.ResourceCursor
	if page.After != "" {
		var decoded projectrepo.ResourceCursor
		if err := httpapi.DecodeCursor(page.After, scope, &decoded); err != nil ||
			decoded.ID == uuid.Nil || decoded.SortOrder < 0 {
			workmanagement.WriteInvalidCursor(response, request)
			return
		}
		after = &decoded
	}
	user := auth.MustUser(request.Context())
	rows, err := handler.service.ListResources(
		request.Context(),
		user.ID,
		projectID,
		after,
		page.First+1,
	)
	if !writeServiceError(response, request, err, "Project") {
		return
	}
	hasNext := len(rows) > page.First
	if hasNext {
		rows = rows[:page.First]
	}
	nodes := make([]resourceResource, 0, len(rows))
	for _, resource := range rows {
		nodes = append(nodes, serializeResource(resource))
	}
	var endCursor *string
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		encoded, err := httpapi.EncodeCursor(scope, projectrepo.ResourceCursor{
			SortOrder: last.SortOrder,
			ID:        last.ID,
		})
		if err != nil {
			workmanagement.WriteInternal(response, request)
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, resourceConnection{
		Nodes: nodes,
		PageInfo: workmanagement.PageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

func (handler *handlers) createResource(
	response http.ResponseWriter,
	request *http.Request,
) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	input, ok := parseCreateResource(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	resource, err := handler.service.CreateResource(
		request.Context(),
		user.ID,
		projectID,
		input,
	)
	if !writeServiceError(response, request, err, "Project resource") {
		return
	}
	response.Header().Set(
		"Location",
		"/api/v1/projects/"+projectID.String()+"/resources/"+resource.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, serializeResource(resource))
}

func (handler *handlers) updateResource(
	response http.ResponseWriter,
	request *http.Request,
) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	resourceID, ok := parsePathID(response, request, "resourceId", "Project resource")
	if !ok {
		return
	}
	patch, ok := parseResourcePatch(response, request)
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	resource, err := handler.service.UpdateResource(
		request.Context(),
		user.ID,
		projectID,
		resourceID,
		patch,
	)
	if !writeServiceError(response, request, err, "Project resource") {
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeResource(resource))
}

func (handler *handlers) deleteResource(
	response http.ResponseWriter,
	request *http.Request,
) {
	projectID, ok := parsePathID(response, request, "projectId", "Project")
	if !ok {
		return
	}
	resourceID, ok := parsePathID(response, request, "resourceId", "Project resource")
	if !ok {
		return
	}
	user := auth.MustUser(request.Context())
	err := handler.service.DeleteResource(request.Context(), user.ID, projectID, resourceID)
	if !writeServiceError(response, request, err, "Project resource") {
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func parsePathID(
	response http.ResponseWriter,
	request *http.Request,
	name, resource string,
) (uuid.UUID, bool) {
	id, ok := workmanagement.ParseCanonicalUUID(chi.URLParam(request, name))
	if !ok {
		workmanagement.WriteNotFound(response, request, resource)
		return uuid.Nil, false
	}
	return id, true
}

func parseQueryUUID(
	response http.ResponseWriter,
	request *http.Request,
	name string,
	required bool,
) (uuid.UUID, bool) {
	raw, present := request.URL.Query()[name]
	if !present || raw[0] == "" {
		if required {
			workmanagement.WriteInvalidQuery(
				response,
				request,
				"/query/"+name,
				name+" is required.",
			)
			return uuid.Nil, false
		}
		return uuid.Nil, true
	}
	id, ok := workmanagement.ParseCanonicalUUID(raw[0])
	if !ok {
		workmanagement.WriteInvalidQuery(
			response,
			request,
			"/query/"+name,
			name+" must be a canonical UUID.",
		)
		return uuid.Nil, false
	}
	return id, true
}

func parseListFilter(
	response http.ResponseWriter,
	request *http.Request,
) (projectrepo.ListFilter, bool) {
	filter := projectrepo.ListFilter{}
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
			return projectrepo.ListFilter{}, false
		}
	}
	if raw := request.URL.Query().Get("status"); raw != "" {
		status := projectrepo.Status(raw)
		if !status.Valid() {
			workmanagement.WriteInvalidQuery(
				response,
				request,
				"/query/status",
				"status is not supported.",
			)
			return projectrepo.ListFilter{}, false
		}
		filter.Status = &status
	}
	if raw := request.URL.Query().Get("priority"); raw != "" {
		priority := projectrepo.Priority(raw)
		if !priority.Valid() {
			workmanagement.WriteInvalidQuery(
				response,
				request,
				"/query/priority",
				"priority is not supported.",
			)
			return projectrepo.ListFilter{}, false
		}
		filter.Priority = &priority
	}
	return filter, true
}

func writeServiceError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound), errors.Is(err, projectrepo.ErrNotFound):
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
	case errors.Is(err, projectrepo.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The requested project change conflicts with existing data.",
			nil,
		)
	default:
		workmanagement.WriteInternal(response, request)
	}
	return false
}

func serializeProject(project projectrepo.Project) projectResource {
	return projectResource{
		ID:          project.ID,
		WorkspaceID: project.WorkspaceID,
		Name:        project.Name,
		Description: project.Description,
		Status:      project.Status,
		Priority:    project.Priority,
		StartDate:   formatDate(project.StartDate),
		TargetDate:  formatDate(project.TargetDate),
		GitHubRepo:  project.GitHubRepoFullName,
		CreatedAt:   project.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   project.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func serializeResource(resource projectrepo.Resource) resourceResource {
	return resourceResource{
		ID:          resource.ID,
		ProjectID:   resource.ProjectID,
		Kind:        resource.Kind,
		URL:         resource.URL,
		Label:       resource.Label,
		Description: resource.Description,
		SortOrder:   resource.SortOrder,
		CreatedAt:   resource.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   resource.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func formatDate(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format("2006-01-02")
	return &formatted
}

func optionalStatus(value *projectrepo.Status) string {
	if value == nil {
		return ""
	}
	return string(*value)
}

func optionalPriority(value *projectrepo.Priority) string {
	if value == nil {
		return ""
	}
	return string(*value)
}
