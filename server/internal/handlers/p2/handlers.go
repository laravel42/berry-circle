// Package p2handler exports disjoint authenticated P2 route mounts.
package p2handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
	p2service "github.com/laravel42/berry-circle/server/internal/service/p2"
)

type API interface {
	ListSavedViews(context.Context, uuid.UUID, uuid.UUID, *p2repo.SavedViewCursor, int) ([]p2repo.SavedView, error)
	CreateSavedView(context.Context, uuid.UUID, uuid.UUID, string, string, int, json.RawMessage, json.RawMessage) (p2repo.SavedView, error)
	GetSavedView(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) (p2repo.SavedView, error)
	UpdateSavedView(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, *string, *string, json.RawMessage, json.RawMessage, int) (p2repo.SavedView, error)
	DeleteSavedView(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	GetViewPreference(context.Context, uuid.UUID, uuid.UUID) (p2repo.ViewPreference, error)
	PutViewPreference(context.Context, uuid.UUID, uuid.UUID, *uuid.UUID, json.RawMessage) (p2repo.ViewPreference, error)
	ListPins(context.Context, uuid.UUID, uuid.UUID) ([]p2repo.Pin, error)
	CreatePin(context.Context, uuid.UUID, uuid.UUID, string, uuid.UUID) (p2repo.Pin, bool, error)
	ReorderPins(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) error
	DeletePin(context.Context, uuid.UUID, uuid.UUID, uuid.UUID) error
	ListInbox(context.Context, uuid.UUID, uuid.UUID, p2repo.InboxFilter) ([]p2repo.InboxItem, error)
	CountUnreadInbox(context.Context, uuid.UUID, uuid.UUID) (int64, error)
	UpdateInboxItem(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string) (p2repo.InboxItem, error)
	BulkUpdateInbox(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID, string) ([]uuid.UUID, error)
	GetNotificationPreferences(context.Context, uuid.UUID, uuid.UUID) (p2repo.NotificationPreferences, error)
	PutNotificationPreferences(context.Context, uuid.UUID, uuid.UUID, json.RawMessage) (p2repo.NotificationPreferences, error)
	Search(context.Context, uuid.UUID, uuid.UUID, p2repo.SearchFilter) ([]p2repo.SearchResult, error)
	ListIssueGroups(context.Context, uuid.UUID, uuid.UUID, p2repo.IssueFilter, string, *p2repo.IssueGroupCursor, int) ([]p2repo.IssueGroup, error)
	ListIssueRows(context.Context, uuid.UUID, uuid.UUID, p2repo.IssueFilter, string, string, *p2repo.IssueRowCursor, int) ([]p2repo.IssueRow, error)
	ListIssueFacets(context.Context, uuid.UUID, uuid.UUID, p2repo.IssueFilter) ([]p2repo.FacetCount, error)
	BatchUpdateIssues(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID, p2repo.BatchIssuePatch) ([]p2repo.BatchResult, []core.IssueMutationEvent, error)
	BatchDeleteIssues(context.Context, uuid.UUID, uuid.UUID, []uuid.UUID) ([]p2repo.BatchResult, []core.IssueMutationEvent, error)
}

type Options struct {
	Sessions         auth.SessionResolver
	Service          API
	IdempotencyStore httpapi.IdempotencyStore
	Clock            func() time.Time
	// Broadcaster is optional: the batch routes publish their issue.* facts
	// live after commit, and the durable outbox rows exist either way.
	Broadcaster realtime.Broadcaster
}

type handler struct {
	service     API
	broadcaster realtime.Broadcaster
}

func NewMounts(options Options) ([]httpapi.Mount, error) {
	switch {
	case options.Sessions == nil:
		return nil, errors.New("p2 handler session resolver is nil")
	case options.Service == nil:
		return nil, errors.New("p2 handler service is nil")
	case options.IdempotencyStore == nil:
		return nil, errors.New("p2 handler idempotency store is nil")
	case options.Clock == nil:
		return nil, errors.New("p2 handler clock is nil")
	}
	target := &handler{service: options.Service, broadcaster: options.Broadcaster}
	requireAuth := auth.RequireSession(options.Sessions)

	views := httpapi.NewSubrouter()
	views.Use(requireAuth)
	views.Get("/", target.listSavedViews)
	views.Post("/", requireIdempotency(
		options.IdempotencyStore,
		options.Clock,
		http.HandlerFunc(target.createSavedView),
	).ServeHTTP)
	views.Get("/{viewId}", target.getSavedView)
	views.Patch("/{viewId}", target.updateSavedView)
	views.Delete("/{viewId}", target.deleteSavedView)

	viewPreferences := httpapi.NewSubrouter()
	viewPreferences.Use(requireAuth)
	viewPreferences.Get("/", target.getViewPreference)
	viewPreferences.Put("/", target.putViewPreference)

	pins := httpapi.NewSubrouter()
	pins.Use(requireAuth)
	pins.Get("/", target.listPins)
	pins.Post("/", requireIdempotency(
		options.IdempotencyStore,
		options.Clock,
		http.HandlerFunc(target.createPin),
	).ServeHTTP)
	pins.Put("/order", target.reorderPins)
	pins.Delete("/{pinId}", target.deletePin)

	inbox := httpapi.NewSubrouter()
	inbox.Use(requireAuth)
	inbox.Get("/", target.listInbox)
	inbox.Get("/unread-count", target.countUnreadInbox)
	inbox.Post("/bulk", target.bulkUpdateInbox)
	inbox.Post("/{itemId}/{action}", target.updateInboxItem)

	notifications := httpapi.NewSubrouter()
	notifications.Use(requireAuth)
	notifications.Get("/", target.getNotificationPreferences)
	notifications.Put("/", target.putNotificationPreferences)
	notifications.Patch("/", target.patchNotificationPreferences)

	search := httpapi.NewSubrouter()
	search.Use(requireAuth)
	search.Get("/", target.search)

	issueQuery := httpapi.NewSubrouter()
	issueQuery.Use(requireAuth)
	issueQuery.Post("/groups", target.issueGroups)
	issueQuery.Post("/rows", target.issueRows)
	issueQuery.Post("/facets", target.issueFacets)
	issueQuery.Post("/batch-update", target.batchUpdateIssues)
	issueQuery.Post("/batch-delete", target.batchDeleteIssues)

	return []httpapi.Mount{
		{Prefix: "/api/v1/views", Handler: views},
		{Prefix: "/api/v1/view-preferences", Handler: viewPreferences},
		{Prefix: "/api/v1/pins", Handler: pins},
		{Prefix: "/api/v1/inbox", Handler: inbox},
		{Prefix: "/api/v1/notification-preferences", Handler: notifications},
		{Prefix: "/api/v1/search", Handler: search},
		{Prefix: "/api/v1/issue-query", Handler: issueQuery},
	}, nil
}

func Mounts(options Options) []httpapi.Mount {
	mounts, err := NewMounts(options)
	if err != nil {
		panic(fmt.Sprintf("construct P2 handlers: %v", err))
	}
	return mounts
}

func currentUser(request *http.Request) auth.User {
	return auth.MustUser(request.Context())
}

func writeDomainError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) {
	switch {
	case errors.Is(err, identity.ErrNotFound), errors.Is(err, p2repo.ErrNotFound):
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			resource+" not found.",
			nil,
		)
	case errors.Is(err, identity.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	case errors.Is(err, p2repo.ErrRevisionConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"REVISION_CONFLICT",
			"The saved view was modified by another request.",
			nil,
		)
	case errors.Is(err, p2repo.ErrInvalidOrder):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"PIN_ORDER_CONFLICT",
			"The pin order no longer matches the current collection.",
			nil,
		)
	case errors.Is(err, p2repo.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The requested operation conflicts with current state.",
			nil,
		)
	case errors.Is(err, p2repo.ErrQueryTimeout):
		httpapi.WriteError(
			response,
			request,
			http.StatusServiceUnavailable,
			"QUERY_TIMEOUT",
			"The bounded query could not complete in time.",
			nil,
		)
	case errors.Is(err, p2service.ErrProjectValidationUnavailable):
		httpapi.WriteError(
			response,
			request,
			http.StatusServiceUnavailable,
			"PROJECTS_UNAVAILABLE",
			"Project pin validation is unavailable.",
			nil,
		)
	default:
		httpapi.WriteError(
			response,
			request,
			http.StatusInternalServerError,
			"INTERNAL",
			"Internal server error.",
			nil,
		)
	}
}
