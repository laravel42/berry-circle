package identityhandler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/mail"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

const maxIdentityBodyBytes = 64 * 1024

var (
	workspaceSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$`)
	issuePrefixPattern   = regexp.MustCompile(`^[A-Z][A-Z0-9]{1,11}$`)
)

func decodeBody[T any](
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
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, maxIdentityBodyBytes))
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
			return zero, nil, false
		}
		writeInvalidJSON(response, request)
		return zero, nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var result T
	if err := decoder.Decode(&result); err != nil {
		if errors.Is(err, io.EOF) {
			writeInvalidJSON(response, request)
		} else {
			writeValidation(
				response,
				request,
				fieldError(
					"/",
					"invalid_value",
					"The request contains an unknown field or invalid value.",
				),
			)
		}
		return zero, nil, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeInvalidJSON(response, request)
		return zero, nil, false
	}
	return result, body, true
}

func requireIdempotency(
	response http.ResponseWriter,
	request *http.Request,
	body []byte,
) (string, [32]byte, bool) {
	values := request.Header.Values("Idempotency-Key")
	if len(values) != 1 || httpapi.ValidateIdempotencyKey(values[0]) != nil {
		writeValidation(
			response,
			request,
			fieldError(
				"/headers/Idempotency-Key",
				"invalid",
				"Idempotency-Key must be one visible ASCII value from 16 to 128 characters.",
			),
		)
		return "", [32]byte{}, false
	}
	fingerprint, err := httpapi.FingerprintJSON(body)
	if err != nil {
		writeInvalidJSON(response, request)
		return "", [32]byte{}, false
	}
	return values[0], fingerprint, true
}

func parseTimePage(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
) (int, *identity.TimeCursor, bool) {
	first, encoded, ok := parsePageQuery(response, request)
	if !ok {
		return 0, nil, false
	}
	if encoded == "" {
		return first, nil, true
	}
	var cursor identity.TimeCursor
	if err := httpapi.DecodeCursor(encoded, scope, &cursor); err != nil ||
		cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
		writeInvalidCursor(response, request)
		return 0, nil, false
	}
	return first, &cursor, true
}

func parseNamePage(
	response http.ResponseWriter,
	request *http.Request,
	scope string,
) (int, *identity.NameCursor, bool) {
	first, encoded, ok := parsePageQuery(response, request)
	if !ok {
		return 0, nil, false
	}
	if encoded == "" {
		return first, nil, true
	}
	var cursor identity.NameCursor
	if err := httpapi.DecodeCursor(encoded, scope, &cursor); err != nil ||
		cursor.ID == uuid.Nil || cursor.Name == "" {
		writeInvalidCursor(response, request)
		return 0, nil, false
	}
	return first, &cursor, true
}

func parsePageQuery(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	values := request.URL.Query()
	for name, entries := range values {
		if name != "first" && name != "after" {
			writeValidation(
				response,
				request,
				fieldError("/query/"+name, "unknown", "Unknown query parameter."),
			)
			return 0, "", false
		}
		if len(entries) != 1 {
			writeValidation(
				response,
				request,
				fieldError(
					"/query/"+name,
					"duplicate",
					"Query parameter must appear once.",
				),
			)
			return 0, "", false
		}
	}
	first := 50
	if raw := values.Get("first"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			writeValidation(
				response,
				request,
				fieldError(
					"/query/first",
					"out_of_range",
					"first must be an integer from 1 to 100.",
				),
			)
			return 0, "", false
		}
		first = parsed
	}
	return first, values.Get("after"), true
}

func parseID(
	response http.ResponseWriter,
	request *http.Request,
	raw, resource string,
) (uuid.UUID, bool) {
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || !strings.EqualFold(id.String(), raw) {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			resource+" not found.",
			nil,
		)
		return uuid.Nil, false
	}
	return id, true
}

func validBounded(value string, minimum, maximum int) bool {
	count := utf8.RuneCountInString(value)
	return utf8.ValidString(value) && count >= minimum && count <= maximum
}

func validEmail(value string) bool {
	if value != strings.ToLower(value) || !validBounded(value, 3, 320) {
		return false
	}
	address, err := mail.ParseAddress(value)
	return err == nil && address.Address == value && strings.Contains(value, "@")
}

func validAvatar(value string) bool {
	if !validBounded(value, 1, 2048) {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" && parsed.User == nil
}

func validTimezone(value string) bool {
	if !validBounded(value, 1, 100) {
		return false
	}
	_, err := time.LoadLocation(value)
	return err == nil
}

func validWorkspaceSlug(value string) bool {
	return len(value) >= 2 && len(value) <= 50 && workspaceSlugPattern.MatchString(value)
}

func validIssuePrefix(value string) bool {
	return issuePrefixPattern.MatchString(value)
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
		"Request body must contain one valid JSON value.",
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
