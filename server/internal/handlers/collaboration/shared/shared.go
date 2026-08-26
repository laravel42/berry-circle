// Package shared contains HTTP-only helpers used by the disjoint P2
// collaboration handler packages.
package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	repository "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

const MaxJSONBodyBytes = 64 * 1024

// DecodeJSON applies the strict Berry JSON boundary.
func DecodeJSON(
	response http.ResponseWriter,
	request *http.Request,
	target any,
	maxBytes int64,
) bool {
	if maxBytes <= 0 {
		maxBytes = MaxJSONBodyBytes
	}
	request.Body = http.MaxBytesReader(response, request.Body, maxBytes)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			httpapi.WriteError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"PAYLOAD_TOO_LARGE",
				"Request body is too large.",
				nil,
			)
			return false
		}
		var syntaxError *json.SyntaxError
		if errors.As(err, &syntaxError) || errors.Is(err, io.EOF) {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request body is not valid JSON.",
				nil,
			)
			return false
		}
		WriteValidation(response, request, httpapi.FieldError{
			Path:    "/",
			Code:    "invalid_type",
			Message: "The request body contains an unknown field or invalid value.",
		})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_REQUEST",
			"The request body is not valid JSON.",
			nil,
		)
		return false
	}
	return true
}

// WriteValidation emits field errors in the shared envelope.
func WriteValidation(
	response http.ResponseWriter,
	request *http.Request,
	fields ...httpapi.FieldError,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnprocessableEntity,
		"VALIDATION_FAILED",
		"The request is invalid.",
		httpapi.ValidationDetails{Fields: fields},
	)
}

// WriteRepositoryError maps hidden membership-aware repository errors once.
func WriteRepositoryError(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) {
	switch {
	case errors.Is(err, repository.ErrNotFound):
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			resource+" not found.",
			nil,
		)
	case errors.Is(err, repository.ErrForbidden):
		httpapi.WriteError(
			response,
			request,
			http.StatusForbidden,
			"FORBIDDEN",
			"You do not have permission to perform this action.",
			nil,
		)
	case errors.Is(err, repository.ErrConflict):
		httpapi.WriteError(
			response,
			request,
			http.StatusConflict,
			"CONFLICT",
			"The operation conflicts with current state.",
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

// Publish delivers an already-committed outbox fact. Realtime failure cannot
// roll back or hide the authoritative PostgreSQL mutation.
//
// The workspace is the delivery scope of record and the board a second one,
// so the board stream that subscribes on its board id wakes up for a comment
// or reaction the same way it does for a run event.
func Publish(
	ctx context.Context,
	broadcaster realtime.Broadcaster,
	event repository.Event,
) {
	if broadcaster == nil || event.ID == uuid.Nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = broadcaster.Publish(publishCtx, realtime.Event{
		ID:          event.ID.String(),
		WorkspaceID: event.WorkspaceID.String(),
		BoardID:     boardScope(event.BoardID),
		Type:        event.Topic,
		Payload:     event.Payload,
		OccurredAt:  event.OccurredAt,
	})
}

// PublishIssue delivers committed issue.* facts the same way. Every mutation
// path that writes them — the issue routes, the p2 batch routes and project
// planning — calls this after its commit so no writer forgets the live
// wakeup.
func PublishIssue(
	ctx context.Context,
	broadcaster realtime.Broadcaster,
	events []core.IssueMutationEvent,
) {
	if broadcaster == nil || len(events) == 0 {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, event := range events {
		if event.ID == uuid.Nil {
			continue
		}
		_ = broadcaster.Publish(publishCtx, realtime.Event{
			ID:          event.ID.String(),
			WorkspaceID: event.WorkspaceID.String(),
			BoardID:     boardScope(event.BoardID),
			Type:        event.Type,
			Payload:     event.Payload,
			OccurredAt:  event.OccurredAt,
		})
	}
}

func boardScope(boardID uuid.UUID) string {
	if boardID == uuid.Nil {
		return ""
	}
	return boardID.String()
}

// RequireJSONIdempotency applies the actor/method/path/body replay contract to
// bounded create endpoints.
func RequireJSONIdempotency(
	store httpapi.IdempotencyStore,
	now func() time.Time,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		keys := request.Header.Values("Idempotency-Key")
		if len(keys) != 1 || httpapi.ValidateIdempotencyKey(keys[0]) != nil {
			WriteValidation(response, request, httpapi.FieldError{
				Path:    "/headers/Idempotency-Key",
				Code:    "invalid",
				Message: "Idempotency-Key must contain 16 to 128 visible ASCII characters.",
			})
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, MaxJSONBodyBytes+1))
		if err != nil {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request body is not valid JSON.",
				nil,
			)
			return
		}
		if len(body) > MaxJSONBodyBytes {
			httpapi.WriteError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"PAYLOAD_TOO_LARGE",
				"Request body is too large.",
				nil,
			)
			return
		}
		fingerprint, err := httpapi.FingerprintJSON(body)
		if err != nil {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request body is not valid JSON.",
				nil,
			)
			return
		}
		user, ok := auth.UserFromContext(request.Context())
		if !ok {
			httpapi.WriteError(
				response,
				request,
				http.StatusUnauthorized,
				"UNAUTHENTICATED",
				"Authentication required.",
				nil,
			)
			return
		}
		result, err := store.Begin(
			request.Context(),
			httpapi.ActorScope{
				ActorType:     "user",
				ActorID:       user.ID,
				Method:        http.MethodPost,
				CanonicalPath: request.URL.Path,
			},
			keys[0],
			fingerprint,
			now().UTC(),
		)
		if err != nil {
			WriteRepositoryError(response, request, err, "Resource")
			return
		}
		switch result.Decision {
		case httpapi.IdempotencyReplay:
			httpapi.Replay(response, result.Response)
			return
		case httpapi.IdempotencyConflict:
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"IDEMPOTENCY_CONFLICT",
				"Idempotency-Key was already used with a different request body.",
				nil,
			)
			return
		case httpapi.IdempotencyInProgress:
			response.Header().Set("Retry-After", "1")
			httpapi.WriteError(
				response,
				request,
				http.StatusConflict,
				"CONFLICT",
				"An identical request is already in progress.",
				nil,
			)
			return
		case httpapi.IdempotencyProceed:
		default:
			WriteRepositoryError(response, request, errors.New("invalid idempotency decision"), "Resource")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		captured := newBufferedResponse()
		completed := false
		defer func() {
			if recovered := recover(); recovered != nil {
				if !completed {
					_ = store.Abandon(
						context.WithoutCancel(request.Context()),
						result.ClaimID,
					)
				}
				panic(recovered)
			}
		}()
		next.ServeHTTP(captured, request)
		stored := httpapi.StoredResponse{
			Status:  captured.statusCode(),
			Headers: captured.header.Clone(),
			Body:    bytes.Clone(captured.body.Bytes()),
		}
		if err := store.Complete(
			context.WithoutCancel(request.Context()),
			result.ClaimID,
			stored,
			now().UTC(),
		); err != nil {
			_ = store.Abandon(
				context.WithoutCancel(request.Context()),
				result.ClaimID,
			)
			if stored.Status < http.StatusInternalServerError {
				httpapi.WriteError(
					response,
					request,
					http.StatusInternalServerError,
					"INTERNAL",
					"Internal server error.",
					nil,
				)
				return
			}
		}
		completed = true
		copyResponse(response, captured)
	})
}

type bufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newBufferedResponse() *bufferedResponse {
	return &bufferedResponse{header: make(http.Header)}
}

func (response *bufferedResponse) Header() http.Header {
	return response.header
}

func (response *bufferedResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *bufferedResponse) Write(body []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(body)
}

func (response *bufferedResponse) statusCode() int {
	if response.status == 0 {
		return http.StatusOK
	}
	return response.status
}

func copyResponse(destination http.ResponseWriter, source *bufferedResponse) {
	for name, values := range source.header {
		for _, value := range values {
			destination.Header().Add(name, value)
		}
	}
	destination.WriteHeader(source.statusCode())
	_, _ = destination.Write(source.body.Bytes())
}
