package resolutions

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	shared "github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
)

const resolutionBodyBytes = int64(64)

type Store interface {
	ResolveComment(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.ResolutionResult, error)
	UnresolveComment(
		context.Context,
		uuid.UUID,
		uuid.UUID,
		uuid.UUID,
		time.Time,
	) (repository.ResolutionResult, error)
}

type Options struct {
	Store            Store
	Sessions         auth.SessionResolver
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
}

type handlerOptions struct {
	Store            Store
	Clock            func() time.Time
	NewID            func() uuid.UUID
	IdempotencyStore httpapi.IdempotencyStore
	Broadcaster      realtime.Broadcaster
}

type resolutionResource struct {
	CommentID  uuid.UUID      `json:"commentId"`
	Revision   int64          `json:"revision"`
	Resolved   bool           `json:"resolved"`
	ResolvedAt *time.Time     `json:"resolvedAt"`
	ResolvedBy *actorResource `json:"resolvedBy"`
}

type actorResource struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

type emptyBody struct{}

func NewCommentHandler(options Options) (http.Handler, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("resolution store is nil")
	case options.Sessions == nil:
		return nil, errors.New("resolution session resolver is nil")
	case options.Clock == nil:
		return nil, errors.New("resolution clock is nil")
	case options.NewID == nil:
		return nil, errors.New("resolution ID generator is nil")
	case options.IdempotencyStore == nil:
		return nil, errors.New("resolution idempotency store is nil")
	case options.Broadcaster == nil:
		return nil, errors.New("resolution broadcaster is nil")
	}
	dependencies := handlerOptions{
		Store:            options.Store,
		Clock:            options.Clock,
		NewID:            options.NewID,
		IdempotencyStore: options.IdempotencyStore,
		Broadcaster:      options.Broadcaster,
	}
	router := httpapi.NewSubrouter()
	router.Use(auth.RequireSession(options.Sessions))
	router.Post(
		"/",
		shared.RequireJSONIdempotency(
			dependencies.IdempotencyStore,
			dependencies.Clock,
			http.HandlerFunc(resolveHandler(dependencies)),
		).ServeHTTP,
	)
	router.Delete("/", unresolveHandler(dependencies))
	return router, nil
}

func resolveHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		var body emptyBody
		if !shared.DecodeJSON(
			response,
			request,
			&body,
			resolutionBodyBytes,
		) {
			return
		}
		commentID, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		result, err := options.Store.ResolveComment(
			request.Context(),
			user.ID,
			commentID,
			options.NewID(),
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Comment")
			return
		}
		for _, event := range result.Events {
			shared.Publish(request.Context(), options.Broadcaster, event)
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeResolution(result))
	}
}

func unresolveHandler(options handlerOptions) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		commentID, ok := parseCommentID(response, request)
		if !ok {
			return
		}
		user := auth.MustUser(request.Context())
		result, err := options.Store.UnresolveComment(
			request.Context(),
			user.ID,
			commentID,
			options.NewID(),
			options.Clock().UTC(),
		)
		if err != nil {
			shared.WriteRepositoryError(response, request, err, "Comment")
			return
		}
		for _, event := range result.Events {
			shared.Publish(request.Context(), options.Broadcaster, event)
		}
		httpapi.WriteJSON(response, http.StatusOK, serializeResolution(result))
	}
}

func parseCommentID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	value := chi.URLParam(request, "commentId")
	commentID, err := uuid.Parse(value)
	if err != nil || commentID == uuid.Nil || commentID.Variant() != uuid.RFC4122 {
		shared.WriteValidation(response, request, httpapi.FieldError{
			Path:    "/path/commentId",
			Code:    "invalid_string",
			Message: "commentId must be a UUID.",
		})
		return uuid.Nil, false
	}
	return commentID, true
}

func serializeResolution(result repository.ResolutionResult) resolutionResource {
	resource := resolutionResource{
		CommentID:  result.Resolution.CommentID,
		Revision:   result.Resolution.Revision,
		Resolved:   result.Resolution.Resolved,
		ResolvedAt: result.Resolution.At,
	}
	if result.Resolution.By != nil {
		resource.ResolvedBy = &actorResource{
			ID:        result.Resolution.By.ID,
			Name:      result.Resolution.By.Name,
			AvatarURL: result.Resolution.By.AvatarURL,
		}
	}
	return resource
}
