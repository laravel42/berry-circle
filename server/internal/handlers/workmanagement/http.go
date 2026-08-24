// Package workmanagement contains transport helpers shared only by the P2
// project and catalog mounts.
package workmanagement

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

const MaxBodyBytes int64 = 64 * 1024

// Optional distinguishes an omitted field, explicit null, and a concrete value.
type Optional[T any] struct {
	Set   bool
	Null  bool
	Value T
}

// UnmarshalJSON records presence before decoding a concrete value.
func (field *Optional[T]) UnmarshalJSON(encoded []byte) error {
	field.Set = true
	if bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
		field.Null = true
		return nil
	}
	return json.Unmarshal(encoded, &field.Value)
}

// Page is the validated common forward-pagination request.
type Page struct {
	First int
	After string
}

// PageInfo is the common connection metadata.
type PageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

// DecodeJSON enforces one bounded, strict application/json object.
func DecodeJSON[T any](
	response http.ResponseWriter,
	request *http.Request,
) (T, []byte, bool) {
	var zero T
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		httpapi.WriteError(
			response,
			request,
			http.StatusUnsupportedMediaType,
			"UNSUPPORTED_MEDIA_TYPE",
			"Content-Type must be application/json.",
			nil,
		)
		return zero, nil, false
	}
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, MaxBodyBytes))
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			httpapi.WriteError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"PAYLOAD_TOO_LARGE",
				"Request body is too large.",
				nil,
			)
		} else {
			WriteInvalidJSON(response, request)
		}
		return zero, nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var decoded T
	if err := decoder.Decode(&decoded); err != nil {
		if errors.Is(err, io.EOF) || isSyntaxError(err) {
			WriteInvalidJSON(response, request)
		} else {
			WriteValidation(response, request, httpapi.FieldError{
				Path:    "/",
				Code:    "invalid_value",
				Message: "The request contains an unknown field or invalid value.",
			})
		}
		return zero, nil, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		WriteInvalidJSON(response, request)
		return zero, nil, false
	}
	return decoded, body, true
}

// ParsePage rejects unknown or repeated query parameters.
func ParsePage(
	response http.ResponseWriter,
	request *http.Request,
	allowedExtra ...string,
) (Page, bool) {
	allowed := map[string]struct{}{"first": {}, "after": {}}
	for _, name := range allowedExtra {
		allowed[name] = struct{}{}
	}
	for name, values := range request.URL.Query() {
		if _, ok := allowed[name]; !ok {
			WriteInvalidQuery(response, request, "/query/"+name, "Unknown query parameter.")
			return Page{}, false
		}
		if len(values) != 1 {
			WriteInvalidQuery(
				response,
				request,
				"/query/"+name,
				"Query parameter must appear once.",
			)
			return Page{}, false
		}
	}
	first := 50
	if raw := request.URL.Query().Get("first"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			WriteInvalidQuery(
				response,
				request,
				"/query/first",
				"first must be an integer from 1 to 100.",
			)
			return Page{}, false
		}
		first = parsed
	}
	after := request.URL.Query().Get("after")
	if _, supplied := request.URL.Query()["after"]; supplied && after == "" {
		WriteInvalidCursor(response, request)
		return Page{}, false
	}
	return Page{First: first, After: after}, true
}

// CursorScope binds a cursor to its endpoint and effective filters.
func CursorScope(base string, filters ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(filters, "\x00")))
	return base + "." + hex.EncodeToString(digest[:6])
}

// ParseCanonicalUUID accepts only the lower-case RFC 4122 representation.
func ParseCanonicalUUID(raw string) (uuid.UUID, bool) {
	parsed, err := uuid.Parse(raw)
	return parsed, err == nil && parsed != uuid.Nil && parsed.String() == raw
}

// RequireIdempotency protects one authenticated create/dispatch POST.
func RequireIdempotency(
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
		body, err := io.ReadAll(io.LimitReader(request.Body, MaxBodyBytes+1))
		if err != nil {
			WriteInvalidJSON(response, request)
			return
		}
		if int64(len(body)) > MaxBodyBytes {
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
			WriteInvalidJSON(response, request)
			return
		}
		user, ok := auth.UserFromContext(request.Context())
		if !ok {
			WriteUnauthenticated(response, request)
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
			WriteInternal(response, request)
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
			WriteInternal(response, request)
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
				WriteInternal(response, request)
				return
			}
		}
		completed = true
		copyResponse(response, captured)
	})
}

// WriteAuthorization maps the shared identity boundary without leaking scope.
func WriteAuthorization(
	response http.ResponseWriter,
	request *http.Request,
	err error,
	resource string,
) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, identity.ErrNotFound):
		WriteNotFound(response, request, resource)
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
		WriteInternal(response, request)
	}
	return false
}

// WriteValidation emits the common structured 422 response.
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

// WriteInvalidQuery emits a structured malformed-query response.
func WriteInvalidQuery(
	response http.ResponseWriter,
	request *http.Request,
	path, message string,
) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request query is invalid.",
		httpapi.ValidationDetails{Fields: []httpapi.FieldError{{
			Path:    path,
			Code:    "invalid",
			Message: message,
		}}},
	)
}

// WriteInvalidCursor emits the stable cursor error.
func WriteInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}

// WriteInvalidJSON emits the stable malformed-body error.
func WriteInvalidJSON(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request body is not valid JSON.",
		nil,
	)
}

// WriteNotFound hides missing and inaccessible resources alike.
func WriteNotFound(response http.ResponseWriter, request *http.Request, resource string) {
	httpapi.WriteError(
		response,
		request,
		http.StatusNotFound,
		"NOT_FOUND",
		resource+" not found.",
		nil,
	)
}

// WriteInternal emits no implementation detail.
func WriteInternal(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusInternalServerError,
		"INTERNAL",
		"Internal server error.",
		nil,
	)
}

// WriteUnauthenticated emits the shared authentication response.
func WriteUnauthenticated(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusUnauthorized,
		"UNAUTHENTICATED",
		"Authentication required.",
		nil,
	)
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

func isSyntaxError(err error) bool {
	var syntax *json.SyntaxError
	return errors.As(err, &syntax)
}
