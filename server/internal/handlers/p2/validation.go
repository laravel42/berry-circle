package p2handler

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
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
)

const maxP2BodyBytes = 128 * 1024

func decodeJSON[T any](
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
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxP2BodyBytes))
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
			writeInvalidJSON(response, request)
		}
		return zero, nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var result T
	if err := decoder.Decode(&result); err != nil {
		writeValidation(response, request, fieldError(
			"/",
			"invalid_value",
			"The request contains an unknown field or invalid value.",
		))
		return zero, nil, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeInvalidJSON(response, request)
		return zero, nil, false
	}
	return result, body, true
}

func parseCanonicalUUID(raw string) (uuid.UUID, bool) {
	id, err := uuid.Parse(raw)
	return id, err == nil && id != uuid.Nil && id.Variant() == uuid.RFC4122 &&
		id.String() == raw
}

func parsePathID(
	response http.ResponseWriter,
	request *http.Request,
	raw, resource string,
) (uuid.UUID, bool) {
	id, ok := parseCanonicalUUID(raw)
	if !ok {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			resource+" not found.",
			nil,
		)
	}
	return id, ok
}

func parseWorkspaceQuery(
	response http.ResponseWriter,
	request *http.Request,
	allowed ...string,
) (uuid.UUID, bool) {
	names := map[string]struct{}{"workspaceId": {}}
	for _, name := range allowed {
		names[name] = struct{}{}
	}
	for name, values := range request.URL.Query() {
		if _, ok := names[name]; !ok {
			writeValidation(response, request, fieldError(
				"/query/"+name,
				"unknown",
				"Unknown query parameter.",
			))
			return uuid.Nil, false
		}
		if len(values) != 1 {
			writeValidation(response, request, fieldError(
				"/query/"+name,
				"duplicate",
				"Query parameter must appear once.",
			))
			return uuid.Nil, false
		}
	}
	workspaceID, ok := parseCanonicalUUID(request.URL.Query().Get("workspaceId"))
	if !ok {
		writeValidation(response, request, fieldError(
			"/query/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
		return uuid.Nil, false
	}
	return workspaceID, true
}

func parsePage(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	first := 50
	if raw := request.URL.Query().Get("first"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 100 {
			writeValidation(response, request, fieldError(
				"/query/first",
				"out_of_range",
				"first must be an integer from 1 to 100.",
			))
			return 0, "", false
		}
		first = value
	}
	after := request.URL.Query().Get("after")
	if _, present := request.URL.Query()["after"]; present && after == "" {
		writeInvalidCursor(response, request)
		return 0, "", false
	}
	return first, after, true
}

func validBounded(value string, minimum, maximum int) bool {
	return utf8.ValidString(value) &&
		utf8.RuneCountInString(value) >= minimum &&
		utf8.RuneCountInString(value) <= maximum
}

func validJSONObject(raw json.RawMessage, maximum int) bool {
	if len(raw) == 0 || len(raw) > maximum || !json.Valid(raw) {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(raw, &object) == nil && object != nil
}

func cursorScope(prefix string, value any) string {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return prefix + "." + hex.EncodeToString(sum[:8])
}

func fieldError(path, code, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: code, Message: message}
}

func writeValidation(
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

func writeInvalidJSON(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request body is not valid JSON.",
		nil,
	)
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

func requireIdempotency(
	store httpapi.IdempotencyStore,
	now func() time.Time,
	next http.Handler,
) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		keys := request.Header.Values("Idempotency-Key")
		if len(keys) != 1 || httpapi.ValidateIdempotencyKey(keys[0]) != nil {
			writeValidation(response, request, fieldError(
				"/headers/Idempotency-Key",
				"invalid",
				"Idempotency-Key must contain 16 to 128 visible ASCII characters.",
			))
			return
		}
		body, err := io.ReadAll(io.LimitReader(request.Body, maxP2BodyBytes+1))
		if err != nil {
			writeInvalidJSON(response, request)
			return
		}
		if len(body) > maxP2BodyBytes {
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
				Method:        request.Method,
				CanonicalPath: request.URL.Path,
			},
			keys[0],
			fingerprint,
			now().UTC(),
		)
		if err != nil {
			writeDomainError(response, request, err, "Resource")
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
			writeDomainError(response, request, errors.New("invalid idempotency decision"), "Resource")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		captured := &bufferedResponse{header: make(http.Header)}
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
				writeDomainError(response, request, err, "Resource")
				return
			}
		}
		completed = true
		for name, values := range captured.header {
			for _, value := range values {
				response.Header().Add(name, value)
			}
		}
		response.WriteHeader(captured.statusCode())
		_, _ = response.Write(captured.body.Bytes())
	})
}

type bufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (response *bufferedResponse) Header() http.Header { return response.header }

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

func uniqueStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != value {
			return false
		}
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}
