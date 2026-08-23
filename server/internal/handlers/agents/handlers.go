// Package agents exports the authenticated /api/v1/agents mount.
package agents

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Options contains every process dependency used by agent reconciliation.
type Options struct {
	Pool          *pgxpool.Pool
	Store         Store
	Sessions      auth.SessionResolver
	Authorization Authorizer
	Clock         func() time.Time
	NewID         func() uuid.UUID
	OpenFang      openfang.Runtime
}

// Authorizer is the narrow workspace/agent boundary consumed by agent routes.
type Authorizer interface {
	AuthorizeWorkspace(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Role, error)
	AuthorizeAgent(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		identity.Permission,
	) (identity.Scope, error)
}

// NewMount builds the disjoint authenticated agent route subtree.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Sessions == nil {
		return httpapi.Mount{}, errors.New("agent handler session resolver is nil")
	}
	if options.Authorization == nil {
		return httpapi.Mount{}, errors.New("agent handler authorizer is nil")
	}
	if options.Clock == nil {
		return httpapi.Mount{}, errors.New("agent handler clock is nil")
	}
	if options.NewID == nil {
		return httpapi.Mount{}, errors.New("agent handler ID generator is nil")
	}
	if options.OpenFang == nil {
		return httpapi.Mount{}, errors.New("agent handler runtime client is nil")
	}
	store := options.Store
	if store == nil {
		if options.Pool == nil {
			return httpapi.Mount{}, errors.New("agent handler pool is nil")
		}
		store = PostgresStore{Pool: options.Pool}
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(store, options))
	router.Get("/{agentId}", getHandler(store, options))
	return httpapi.Mount{Prefix: "/api/v1/agents", Handler: router}, nil
}

type resource struct {
	ID           uuid.UUID `json:"id"`
	Name         string    `json:"name"`
	Description  *string   `json:"description"`
	AvatarURL    *string   `json:"avatarUrl"`
	Status       string    `json:"status"`
	Capabilities []string  `json:"capabilities"`
	CreatedAt    string    `json:"createdAt"`
	UpdatedAt    string    `json:"updatedAt"`
}

type connection struct {
	Nodes    []resource `json:"nodes"`
	PageInfo pageInfo   `json:"pageInfo"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type listQuery struct {
	First  int
	After  string
	Status string
}

func listHandler(store Store, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		query, ok := parseListQuery(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		if user.CurrentWorkspaceID == nil {
			writeWorkspaceNotFound(response, request)
			return
		}
		workspaceID := *user.CurrentWorkspaceID
		if _, err := options.Authorization.AuthorizeWorkspace(
			request.Context(),
			user.ID,
			workspaceID,
			identity.PermissionRead,
		); !writeAgentAuthorization(response, request, err, true) {
			return
		}
		summaries, err := options.OpenFang.ListAgents(request.Context())
		if err != nil {
			writeDependencyError(response, request, err)
			return
		}
		now := options.Clock().UTC()
		updates := make([]SummaryUpdate, 0, len(summaries))
		for _, summary := range summaries {
			update, err := projectSummary(summary, workspaceID, options.NewID(), now)
			if err != nil {
				writeDependencyBadResponse(response, request)
				return
			}
			updates = append(updates, update)
		}
		if err := store.SyncSummaries(
			request.Context(),
			workspaceID,
			updates,
			now,
		); err != nil {
			writeInternal(response, request)
			return
		}

		scope := listCursorScope(query.Status)
		var after *Cursor
		if query.After != "" {
			var decoded Cursor
			if err := httpapi.DecodeCursor(query.After, scope, &decoded); err != nil ||
				decoded.ID == uuid.Nil || decoded.Name == "" {
				writeInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		found, err := store.List(
			request.Context(),
			workspaceID,
			query.Status,
			after,
			query.First+1,
		)
		if err != nil {
			writeInternal(response, request)
			return
		}
		hasNextPage := len(found) > query.First
		if hasNextPage {
			found = found[:query.First]
		}
		nodes := make([]resource, 0, len(found))
		for _, item := range found {
			nodes = append(nodes, serialize(item))
		}
		var endCursor *string
		if len(found) > 0 {
			last := found[len(found)-1]
			encoded, err := httpapi.EncodeCursor(scope, Cursor{Name: last.Name, ID: last.ID})
			if err != nil {
				writeInternal(response, request)
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, connection{
			Nodes: nodes,
			PageInfo: pageInfo{
				HasNextPage: hasNextPage,
				EndCursor:   endCursor,
			},
		})
	}
}

func getHandler(store Store, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		id, err := core.ParseUUID(chi.URLParam(request, "agentId"))
		if err != nil {
			writeNotFound(response, request)
			return
		}
		user := auth.MustUser(request.Context())
		scope, err := options.Authorization.AuthorizeAgent(
			request.Context(),
			user.ID,
			id,
			identity.PermissionRead,
		)
		if !writeAgentAuthorization(response, request, err, false) {
			return
		}
		found, err := store.Get(request.Context(), id, scope.WorkspaceID)
		if errors.Is(err, ErrNotFound) {
			writeNotFound(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		detail, err := options.OpenFang.GetAgent(request.Context(), found.OpenFangAgentID)
		if err != nil {
			var upstream *openfang.UpstreamError
			if errors.As(err, &upstream) && upstream.Kind == openfang.ErrorNotFound {
				stale, markErr := store.MarkOffline(
					request.Context(),
					found.ID,
					scope.WorkspaceID,
					options.Clock().UTC(),
				)
				if markErr != nil {
					writeInternal(response, request)
					return
				}
				httpapi.WriteJSON(response, http.StatusOK, serialize(stale))
				return
			}
			writeDependencyError(response, request, err)
			return
		}
		update, err := projectDetail(found, detail)
		if err != nil {
			writeDependencyBadResponse(response, request)
			return
		}
		updated, err := store.UpdateDetail(
			request.Context(),
			update,
			scope.WorkspaceID,
			options.Clock().UTC(),
		)
		if errors.Is(err, ErrNotFound) {
			writeNotFound(response, request)
			return
		}
		if err != nil {
			writeInternal(response, request)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, serialize(updated))
	}
}

func parseListQuery(
	response http.ResponseWriter,
	request *http.Request,
) (listQuery, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "first" && name != "after" && name != "status" {
			writeValidation(response, request, "/query/"+name, "Unknown query parameter.")
			return listQuery{}, false
		}
		if len(entries) != 1 {
			writeValidation(response, request, "/query/"+name, "Query parameter must appear once.")
			return listQuery{}, false
		}
	}
	result := listQuery{First: 50}
	if raw := values.Get("first"); raw != "" {
		first, err := strconv.Atoi(raw)
		if err != nil || first < 1 || first > 100 {
			writeValidation(response, request, "/query/first", "first must be an integer from 1 to 100.")
			return listQuery{}, false
		}
		result.First = first
	}
	result.After = values.Get("after")
	result.Status = values.Get("status")
	if result.Status != "" && !validStatus(result.Status) {
		writeValidation(response, request, "/query/status", "status is not supported.")
		return listQuery{}, false
	}
	return result, true
}

func projectSummary(
	summary openfang.AgentSummary,
	workspaceID uuid.UUID,
	id uuid.UUID,
	now time.Time,
) (SummaryUpdate, error) {
	name := strings.TrimSpace(summary.Name)
	if id == uuid.Nil || summary.ID == uuid.Nil || name == "" ||
		utf8.RuneCountInString(name) > 100 {
		return SummaryUpdate{}, errors.New("invalid runtime agent summary")
	}
	return SummaryUpdate{
		ID:                   id,
		WorkspaceID:          workspaceID,
		OpenFangAgentID:      summary.ID,
		Name:                 name,
		AvatarURL:            safeAvatar(summary.Identity.AvatarURL),
		Status:               normalizeStatus(summary),
		ModelProvider:        nullableTrimmed(summary.ModelProvider, 200),
		ModelName:            nullableTrimmed(summary.ModelName, 500),
		ModelTier:            nullableTrimmed(summary.ModelTier, 100),
		AuthStatus:           nullableTrimmed(summary.AuthStatus, 100),
		UpstreamState:        nullableTrimmed(summary.State, 100),
		UpstreamLastActiveAt: summary.LastActive.UTC(),
		CreatedAt:            summary.CreatedAt.UTC(),
	}, nil
}

func writeAgentAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	workspace bool,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		if workspace {
			writeWorkspaceNotFound(response, request)
		} else {
			writeNotFound(response, request)
		}
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	default:
		writeInternal(response, request)
	}
	return false
}

func writeWorkspaceNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Workspace not found.",
		nil,
	)
}

func projectDetail(found Agent, detail openfang.AgentDetail) (DetailUpdate, error) {
	name := strings.TrimSpace(detail.Name)
	if detail.ID != found.OpenFangAgentID || name == "" ||
		utf8.RuneCountInString(name) > 100 ||
		utf8.RuneCountInString(detail.Description) > 5000 {
		return DetailUpdate{}, errors.New("invalid runtime agent detail")
	}
	var description *string
	if detail.Description != "" {
		value := detail.Description
		description = &value
	}
	capabilities := append([]string(nil), detail.Capabilities.Tools...)
	capabilities = append(capabilities, detail.Capabilities.Network...)
	capabilities = sortedCapabilities(capabilities)
	for _, capability := range capabilities {
		if capability == "" || len(capability) > 200 || !utf8.ValidString(capability) {
			return DetailUpdate{}, errors.New("invalid runtime agent capability")
		}
	}
	status := found.Status
	if !strings.EqualFold(detail.State, "Running") {
		status = "offline"
	} else if status == "offline" || status == "unknown" {
		status = "available"
	}
	return DetailUpdate{
		ID:            found.ID,
		Name:          name,
		Description:   description,
		AvatarURL:     safeAvatar(detail.Identity.AvatarURL),
		Status:        status,
		Capabilities:  capabilities,
		ModelProvider: nullableTrimmed(detail.Model.Provider, 200),
		ModelName:     nullableTrimmed(detail.Model.Model, 500),
		UpstreamState: nullableTrimmed(detail.State, 100),
	}, nil
}

func normalizeStatus(summary openfang.AgentSummary) string {
	switch {
	case summary.IsInferencing:
		return "busy"
	case summary.Ready:
		return "available"
	case strings.EqualFold(summary.State, "Created"),
		strings.EqualFold(summary.State, "Suspended"),
		strings.EqualFold(summary.State, "Terminated"),
		strings.EqualFold(summary.State, "Crashed"):
		return "offline"
	default:
		return "unknown"
	}
}

func safeAvatar(value *string) *string {
	if value == nil || len(*value) > 2048 {
		return nil
	}
	parsed, err := url.Parse(*value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil {
		return nil
	}
	copy := parsed.String()
	return &copy
}

func nullableTrimmed(value string, maxBytes int) *string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxBytes || !utf8.ValidString(value) {
		return nil
	}
	return &value
}

func sortedCapabilities(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	slices.Sort(result)
	return result
}

func serialize(agent Agent) resource {
	capabilities := append([]string(nil), agent.Capabilities...)
	if capabilities == nil {
		capabilities = []string{}
	}
	return resource{
		ID:           agent.ID,
		Name:         agent.Name,
		Description:  agent.Description,
		AvatarURL:    agent.AvatarURL,
		Status:       agent.Status,
		Capabilities: capabilities,
		CreatedAt:    agent.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:    agent.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func listCursorScope(status string) string {
	if status == "" {
		return "agents.list.all"
	}
	return "agents.list." + status
}

func validStatus(status string) bool {
	return status == "available" || status == "busy" ||
		status == "offline" || status == "unknown"
}

func writeValidation(
	response http.ResponseWriter,
	request *http.Request,
	path, message string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request is invalid.",
		httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
			Path: path, Code: "invalid", Message: message,
		}}},
	)
}

func writeInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The cursor is invalid for this query.",
		nil,
	)
}

func writeNotFound(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		"Agent not found.",
		nil,
	)
}

func writeDependencyBadResponse(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadGateway,
		"DEPENDENCY_BAD_RESPONSE",
		"The runtime dependency returned an unusable response.",
		nil,
	)
}

func writeDependencyError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
) {
	var upstream *openfang.UpstreamError
	if errors.As(err, &upstream) && upstream.Kind == openfang.ErrorBadResponse {
		writeDependencyBadResponse(response, request)
		return
	}
	httpapi.WriteError(
		response,
		request,
		http.StatusServiceUnavailable,
		"DEPENDENCY_UNAVAILABLE",
		"The runtime dependency is unavailable.",
		nil,
	)
}

func writeInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}

func (query listQuery) String() string {
	return fmt.Sprintf("first=%d,status=%s", query.First, query.Status)
}
