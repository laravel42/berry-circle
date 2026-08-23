// Package subscribers exposes issue follower-management subroutes.
package subscribers

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

// Store is the narrow subscriber persistence boundary.
type Store interface {
	SubscribeSelf(
		context.Context,
		uuid.UUID,
		string,
		uuid.UUID,
		time.Time,
	) (repository.Subscriber, repository.Event, error)
	AddSubscriber(
		context.Context,
		uuid.UUID,
		string,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Subscriber, repository.Event, error)
	UnsubscribeSelf(
		context.Context,
		uuid.UUID,
		string,
		uuid.UUID,
		time.Time,
	) (repository.Event, error)
	RemoveSubscriber(
		context.Context,
		uuid.UUID,
		string,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.Event, error)
	ListSubscribers(
		context.Context,
		uuid.UUID,
		string,
		*repository.SubscriberCursor,
		int,
	) ([]repository.Subscriber, error)
}

// Options are all process-owned dependencies.
type Options struct {
	Store            Store
	Sessions         auth.SessionResolver
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
}

// NewIssueHandler returns routes mounted at
// /api/v1/issues/{issueRef}/subscribers.
func NewIssueHandler(options Options) (http.Handler, error) {
	if err := validateOptions(options); err != nil {
		return nil, err
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Get("/", listHandler(options))
	router.Post(
		"/",
		shared.RequireJSONIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(addMemberHandler(options)),
		).ServeHTTP,
	)
	router.Post(
		"/self",
		shared.RequireJSONIdempotency(
			options.IdempotencyStore,
			options.Clock,
			http.HandlerFunc(subscribeSelfHandler(options)),
		).ServeHTTP,
	)
	router.Delete("/self", unsubscribeSelfHandler(options))
	router.Delete("/{userId}", removeMemberHandler(options))
	return router, nil
}

func validateOptions(options Options) error {
	switch {
	case options.Store == nil:
		return errors.New("subscriber handler store is nil")
	case options.Sessions == nil:
		return errors.New("subscriber handler session resolver is nil")
	case options.Clock == nil:
		return errors.New("subscriber handler clock is nil")
	case options.NewID == nil:
		return errors.New("subscriber handler ID generator is nil")
	case options.IdempotencyStore == nil:
		return errors.New("subscriber handler idempotency store is nil")
	case options.Broadcaster == nil:
		return errors.New("subscriber handler broadcaster is nil")
	default:
		return nil
	}
}

type emptyBody struct{}

type addSubscriberBody struct {
	UserID *string `json:"userId"`
}

type actorResource struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

type subscriberResource struct {
	User         actorResource `json:"user"`
	Reason       string        `json:"reason"`
	SubscribedAt string        `json:"subscribedAt"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type subscriberConnection struct {
	Nodes    []subscriberResource `json:"nodes"`
	PageInfo pageInfo             `json:"pageInfo"`
}

func subscribeSelfHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var body emptyBody
		if !shared.DecodeJSON(response, request, &body, shared.MaxJSONBodyBytes) {
			return
		}
		user := auth.MustUser(request.Context())
		subscriber, event, err := options.Store.SubscribeSelf(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		httpapi.WriteJSON(response, http.StatusCreated, serializeSubscriber(subscriber))
	}
}

func unsubscribeSelfHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		user := auth.MustUser(request.Context())
		event, err := options.Store.UnsubscribeSelf(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		response.WriteHeader(http.StatusNoContent)
	}
}

func addMemberHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var body addSubscriberBody
		if !shared.DecodeJSON(response, request, &body, shared.MaxJSONBodyBytes) {
			return
		}
		if body.UserID == nil {
			shared.WriteValidation(response, request, httpapi.FieldError{
				Path:    "/userId",
				Code:    "invalid_type",
				Message: "Field is required.",
			})
			return
		}
		targetID, err := core.ParseUUID(*body.UserID)
		if err != nil {
			shared.WriteValidation(response, request, httpapi.FieldError{
				Path:    "/userId",
				Code:    "invalid_string",
				Message: "userId must be a UUID.",
			})
			return
		}
		user := auth.MustUser(request.Context())
		subscriber, event, err := options.Store.AddSubscriber(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			targetID,
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		httpapi.WriteJSON(response, http.StatusCreated, serializeSubscriber(subscriber))
	}
}

func removeMemberHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		targetID, err := core.ParseUUID(chi.URLParam(request, "userId"))
		if err != nil {
			httpapi.WriteError(
				response,
				request,
				http.StatusNotFound,
				"NOT_FOUND",
				"Subscriber not found.",
				nil,
			)
			return
		}
		user := auth.MustUser(request.Context())
		event, err := options.Store.RemoveSubscriber(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			targetID,
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		shared.Publish(request.Context(), options.Broadcaster, event)
		response.WriteHeader(http.StatusNoContent)
	}
}

func listHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		first, encodedAfter, ok := parsePage(response, request)
		if !ok {
			return
		}
		scope := subscriberCursorScope(chi.URLParam(request, "issueRef"))
		var after *repository.SubscriberCursor
		if encodedAfter != "" {
			var decoded repository.SubscriberCursor
			if err := httpapi.DecodeCursor(encodedAfter, scope, &decoded); err != nil ||
				decoded.UserID == uuid.Nil || decoded.CreatedAt.IsZero() {
				writeInvalidCursor(response, request)
				return
			}
			after = &decoded
		}
		user := auth.MustUser(request.Context())
		rows, err := options.Store.ListSubscribers(
			request.Context(),
			user.ID,
			chi.URLParam(request, "issueRef"),
			after,
			first+1,
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Issue")
			return
		}
		hasNextPage := len(rows) > first
		if hasNextPage {
			rows = rows[:first]
		}
		nodes := make([]subscriberResource, 0, len(rows))
		for _, row := range rows {
			nodes = append(nodes, serializeSubscriber(row))
		}
		var endCursor *string
		if len(rows) > 0 {
			last := rows[len(rows)-1]
			encoded, err := httpapi.EncodeCursor(scope, repository.SubscriberCursor{
				CreatedAt: last.CreatedAt,
				UserID:    last.User.ID,
			})
			if err != nil {
				shared.WriteRepositoryError(response, request, err, "Issue")
				return
			}
			endCursor = &encoded
		}
		httpapi.WriteJSON(response, http.StatusOK, subscriberConnection{
			Nodes: nodes,
			PageInfo: pageInfo{
				HasNextPage: hasNextPage,
				EndCursor:   endCursor,
			},
		})
	}
}

func parsePage(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	query := request.URL.Query()
	for name, values := range query {
		if (name != "first" && name != "after") || len(values) != 1 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				nil,
			)
			return 0, "", false
		}
	}
	first := 50
	if raw := query.Get("first"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 100 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
					Path:    "/query/first",
					Code:    "invalid",
					Message: "first must be an integer from 1 to 100.",
				}}},
			)
			return 0, "", false
		}
		first = value
	}
	after := query.Get("after")
	if _, present := query["after"]; present && after == "" {
		writeInvalidCursor(response, request)
		return 0, "", false
	}
	return first, after, true
}

func serializeSubscriber(subscriber repository.Subscriber) subscriberResource {
	return subscriberResource{
		User: actorResource{
			Type:      "user",
			ID:        subscriber.User.ID,
			Name:      subscriber.User.Name,
			AvatarURL: subscriber.User.AvatarURL,
		},
		Reason:       subscriber.Reason,
		SubscribedAt: subscriber.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func subscriberCursorScope(issueReference string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(issueReference)))
	return fmt.Sprintf("subscribers.list.%x", sum[:8])
}

func writeInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}
