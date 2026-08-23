package comments

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

type createCommentBody struct {
	Body     *string `json:"body"`
	ParentID *string `json:"parentId"`
}

type updateCommentBody struct {
	Body     *string `json:"body"`
	Revision *int64  `json:"revision"`
}

func parseCreateComment(
	response http.ResponseWriter,
	request *http.Request,
) (string, *uuid.UUID, bool) {
	var body createCommentBody
	if !decodeCommentJSON(response, request, &body) {
		return "", nil, false
	}
	fields := make([]httpapi.FieldError, 0)
	if body.Body == nil {
		fields = append(fields, commentFieldError("/body", "invalid_type", "Field is required."))
	} else {
		validateCommentBody(&fields, *body.Body)
	}
	var parentID *uuid.UUID
	if body.ParentID != nil {
		parsed, err := core.ParseUUID(*body.ParentID)
		if err != nil {
			fields = append(fields, commentFieldError(
				"/parentId",
				"invalid_string",
				"parentId must be a UUID.",
			))
		} else {
			parentID = &parsed
		}
	}
	if len(fields) > 0 {
		writeCommentValidation(response, request, fields...)
		return "", nil, false
	}
	return *body.Body, parentID, true
}

func parseUpdateComment(
	response http.ResponseWriter,
	request *http.Request,
) (string, *int64, bool) {
	var body updateCommentBody
	if !decodeCommentJSON(response, request, &body) {
		return "", nil, false
	}
	fields := make([]httpapi.FieldError, 0)
	if body.Body == nil {
		fields = append(fields, commentFieldError("/body", "invalid_type", "Field is required."))
	} else {
		validateCommentBody(&fields, *body.Body)
	}
	if body.Revision != nil && *body.Revision < 1 {
		fields = append(fields, commentFieldError(
			"/revision",
			"too_small",
			"revision must be a positive integer.",
		))
	}
	if len(fields) > 0 {
		writeCommentValidation(response, request, fields...)
		return "", nil, false
	}
	return *body.Body, body.Revision, true
}

func parseCommentPage(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	allowed := map[string]struct{}{"first": {}, "after": {}}
	query := request.URL.Query()
	for name, values := range query {
		if _, ok := allowed[name]; !ok || len(values) != 1 {
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
		writeCommentInvalidCursor(response, request)
		return 0, "", false
	}
	return first, after, true
}

func decodeCommentJSON(
	response http.ResponseWriter,
	request *http.Request,
	target any,
) bool {
	request.Body = http.MaxBytesReader(response, request.Body, maxCommentBodyBytes)
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
			writeCommentInvalidJSON(response, request)
			return false
		}
		writeCommentValidation(response, request, commentFieldError(
			"/",
			"invalid_type",
			"The request body contains an unknown field or invalid value.",
		))
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeCommentInvalidJSON(response, request)
		return false
	}
	return true
}

func validateCommentBody(fields *[]httpapi.FieldError, body string) {
	length := utf8.RuneCountInString(body)
	if length < 1 {
		*fields = append(*fields, commentFieldError(
			"/body",
			"too_small",
			"Body must contain at least 1 character.",
		))
	}
	if length > 100000 {
		*fields = append(*fields, commentFieldError(
			"/body",
			"too_big",
			"Body must contain at most 100000 characters.",
		))
	}
}

func commentFieldError(path, code, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: code, Message: message}
}

func writeCommentValidation(
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

func writeCommentInvalidJSON(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request body is not valid JSON.",
		nil,
	)
}

func writeCommentInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}
