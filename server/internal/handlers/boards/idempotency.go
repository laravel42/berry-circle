package boards

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

const maxBoardBodyBytes = 64 * 1024

func requireIdempotency(
	store httpapi.IdempotencyStore,
	now func() time.Time,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		keys := request.Header.Values("Idempotency-Key")
		if len(keys) != 1 || httpapi.ValidateIdempotencyKey(keys[0]) != nil {
			writeValidation(response, request, httpapi.FieldError{
				Path:    "/headers/Idempotency-Key",
				Code:    "invalid",
				Message: "Idempotency-Key must contain 16 to 128 visible ASCII characters.",
			})
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, maxBoardBodyBytes+1))
		if err != nil {
			writeInvalidJSON(response, request)
			return
		}
		if len(body) > maxBoardBodyBytes {
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
			writeInvalidJSON(response, request)
			return
		}
		user, ok := auth.UserFromContext(request.Context())
		if !ok {
			writeUnauthenticated(response, request)
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
			writeInternal(response, request)
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
			writeInternal(response, request)
			return
		}

		request.Body = io.NopCloser(bytes.NewReader(body))
		captured := newBufferedResponse()
		completed := false
		defer func() {
			if recovered := recover(); recovered != nil {
				if !completed {
					_ = store.Abandon(context.WithoutCancel(request.Context()), result.ClaimID)
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
			_ = store.Abandon(context.WithoutCancel(request.Context()), result.ClaimID)
			if stored.Status < http.StatusInternalServerError {
				writeInternal(response, request)
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

func writeUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
}

func isBodyTooLarge(err error) bool {
	var maxBytesError *http.MaxBytesError
	return errors.As(err, &maxBytesError)
}
