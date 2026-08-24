package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
)

var errorCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

type contextKey string

const requestIDKey contextKey = "request-id"

// FieldError is a stable validation detail using JSON Pointer-style paths.
type FieldError struct {
	Path    string `json:"path"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ValidationDetails is the contract shape for field-level failures.
type ValidationDetails struct {
	Fields []FieldError `json:"fields"`
}

// ErrorEnvelope is Berry's only JSON error representation.
type ErrorEnvelope struct {
	Error ErrorBody `json:"error"`
}

// ErrorBody is the exact nested error object.
type ErrorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
	Details   any    `json:"details"`
}

// WriteError emits the central envelope and never exposes an invalid code.
func WriteError(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	code, message string,
	details any,
) {
	if !errorCodePattern.MatchString(code) {
		status = http.StatusInternalServerError
		code = "INTERNAL"
		message = "Internal server error."
		details = nil
	}
	requestID := RequestID(request.Context())
	response.Header().Set("Content-Type", "application/json")
	if requestID != "" {
		response.Header().Set("X-Request-Id", requestID)
	}
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(ErrorEnvelope{
		Error: ErrorBody{
			Code:      code,
			Message:   message,
			RequestID: requestID,
			Details:   details,
		},
	})
}

// WriteJSON emits a camelCase JSON response.
func WriteJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}

// RequestID reads the correlation identifier from context.
func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey).(string)
	return value
}
