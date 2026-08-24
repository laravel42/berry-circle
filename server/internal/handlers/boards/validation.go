package boards

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"unicode/utf8"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

var boardSlugPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,10}[a-z0-9])$`)

var defaultColumns = []core.BoardColumn{
	{ID: "backlog", Name: "Backlog"},
	{ID: "todo", Name: "Todo"},
	{ID: "inProgress", Name: "In progress"},
	{ID: "inReview", Name: "In review"},
	{ID: "done", Name: "Done"},
}

type optional[T any] struct {
	Set   bool
	Null  bool
	Value T
}

func (field *optional[T]) UnmarshalJSON(encoded []byte) error {
	field.Set = true
	if bytes.Equal(bytes.TrimSpace(encoded), []byte("null")) {
		field.Null = true
		return nil
	}
	return json.Unmarshal(encoded, &field.Value)
}

type createBoardBody struct {
	Name        optional[string]             `json:"name"`
	Slug        optional[string]             `json:"slug"`
	Description optional[string]             `json:"description"`
	Columns     optional[[]core.BoardColumn] `json:"columns"`
}

type updateBoardBody struct {
	Name        optional[string]             `json:"name"`
	Slug        optional[string]             `json:"slug"`
	Description optional[string]             `json:"description"`
	Columns     optional[[]core.BoardColumn] `json:"columns"`
}

type createBoardInput struct {
	Name        string
	Slug        string
	Description *string
	Columns     []core.BoardColumn
}

func parseCreateBoard(
	response http.ResponseWriter,
	request *http.Request,
) (createBoardInput, bool) {
	var body createBoardBody
	if !decodeJSON(response, request, maxBoardBodyBytes, &body) {
		return createBoardInput{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	validateRequiredString(&fields, "/name", body.Name, 1, 100)
	validateRequiredSlug(&fields, body.Slug)
	if body.Description.Set && !body.Description.Null &&
		utf8.RuneCountInString(body.Description.Value) > 5000 {
		fields = append(fields, fieldError(
			"/description",
			"too_big",
			"Description must contain at most 5000 characters.",
		))
	}
	columns := append([]core.BoardColumn(nil), defaultColumns...)
	if body.Columns.Set {
		if body.Columns.Null {
			fields = append(fields, fieldError("/columns", "invalid_type", "Columns cannot be null."))
		} else {
			columns = body.Columns.Value
			validateColumns(&fields, columns)
		}
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return createBoardInput{}, false
	}
	var description *string
	if body.Description.Set && !body.Description.Null {
		description = &body.Description.Value
	}
	return createBoardInput{
		Name:        body.Name.Value,
		Slug:        body.Slug.Value,
		Description: description,
		Columns:     columns,
	}, true
}

func parseBoardPatch(
	response http.ResponseWriter,
	request *http.Request,
) (core.BoardPatch, bool) {
	var body updateBoardBody
	if !decodeJSON(response, request, maxBoardBodyBytes, &body) {
		return core.BoardPatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	count := 0
	patch := core.BoardPatch{}
	if body.Name.Set {
		count++
		if body.Name.Null {
			fields = append(fields, fieldError("/name", "invalid_type", "Name cannot be null."))
		} else {
			validateString(&fields, "/name", body.Name.Value, 1, 100, "Name")
			patch.Name = &body.Name.Value
		}
	}
	if body.Slug.Set {
		count++
		if body.Slug.Null {
			fields = append(fields, fieldError("/slug", "invalid_type", "Slug cannot be null."))
		} else {
			validateSlug(&fields, body.Slug.Value)
			patch.Slug = &body.Slug.Value
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			if utf8.RuneCountInString(body.Description.Value) > 5000 {
				fields = append(fields, fieldError(
					"/description",
					"too_big",
					"Description must contain at most 5000 characters.",
				))
			}
			patch.Description = &body.Description.Value
		}
	}
	if body.Columns.Set {
		count++
		if body.Columns.Null {
			fields = append(fields, fieldError("/columns", "invalid_type", "Columns cannot be null."))
		} else {
			validateColumns(&fields, body.Columns.Value)
			columns := append([]core.BoardColumn(nil), body.Columns.Value...)
			patch.Columns = &columns
		}
	}
	if count == 0 {
		fields = append(fields, fieldError(
			"/",
			"too_small",
			"At least one field must be provided.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return core.BoardPatch{}, false
	}
	return patch, true
}

func parsePage(
	response http.ResponseWriter,
	request *http.Request,
) (int, string, bool) {
	allowed := map[string]struct{}{"first": {}, "after": {}}
	for name, values := range request.URL.Query() {
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
	if raw := request.URL.Query().Get("first"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 100 {
			httpapi.WriteError(
				response,
				request,
				http.StatusBadRequest,
				"INVALID_REQUEST",
				"The request query is invalid.",
				map[string]any{"fields": []httpapi.FieldError{{
					Path:    "/query/first",
					Code:    "invalid",
					Message: "first must be an integer from 1 to 100.",
				}}},
			)
			return 0, "", false
		}
		first = parsed
	}
	after := request.URL.Query().Get("after")
	if _, present := request.URL.Query()["after"]; present && after == "" {
		httpapi.WriteError(
			response,
			request,
			http.StatusBadRequest,
			"INVALID_CURSOR",
			"The pagination cursor is invalid.",
			nil,
		)
		return 0, "", false
	}
	return first, after, true
}

func decodeJSON(
	response http.ResponseWriter,
	request *http.Request,
	limit int64,
	target any,
) bool {
	request.Body = http.MaxBytesReader(response, request.Body, limit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		if isBodyTooLarge(err) {
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
			writeInvalidJSON(response, request)
			return false
		}
		writeValidation(response, request, fieldError(
			"/",
			"invalid_type",
			"The request body contains an unknown field or invalid value.",
		))
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeInvalidJSON(response, request)
		return false
	}
	return true
}

func validateRequiredString(
	fields *[]httpapi.FieldError,
	path string,
	value optional[string],
	minimum, maximum int,
) {
	if !value.Set || value.Null {
		*fields = append(*fields, fieldError(path, "invalid_type", "Field is required."))
		return
	}
	label := "Field"
	if path == "/name" {
		label = "Name"
	}
	validateString(fields, path, value.Value, minimum, maximum, label)
}

func validateRequiredSlug(fields *[]httpapi.FieldError, value optional[string]) {
	if !value.Set || value.Null {
		*fields = append(*fields, fieldError("/slug", "invalid_type", "Field is required."))
		return
	}
	validateSlug(fields, value.Value)
}

func validateString(
	fields *[]httpapi.FieldError,
	path, value string,
	minimum, maximum int,
	label string,
) {
	length := utf8.RuneCountInString(value)
	if length < minimum {
		*fields = append(*fields, fieldError(
			path,
			"too_small",
			label+" must contain at least "+strconv.Itoa(minimum)+" character.",
		))
	}
	if length > maximum {
		*fields = append(*fields, fieldError(
			path,
			"too_big",
			label+" must contain at most "+strconv.Itoa(maximum)+" characters.",
		))
	}
}

func validateSlug(fields *[]httpapi.FieldError, slug string) {
	if !boardSlugPattern.MatchString(slug) {
		*fields = append(*fields, fieldError(
			"/slug",
			"invalid_format",
			"Slug must be 2-12 lowercase letters, digits, or hyphens.",
		))
	}
}

func validateColumns(fields *[]httpapi.FieldError, columns []core.BoardColumn) {
	if len(columns) == 0 {
		*fields = append(*fields, fieldError(
			"/columns",
			"too_small",
			"Columns must contain at least one item.",
		))
		return
	}
	validStatus := map[string]struct{}{
		"backlog": {}, "todo": {}, "inProgress": {},
		"inReview": {}, "done": {}, "blocked": {}, "cancelled": {},
	}
	seen := make(map[string]struct{}, len(columns))
	for index, column := range columns {
		base := "/columns/" + strconv.Itoa(index)
		if _, ok := validStatus[column.ID]; !ok {
			*fields = append(*fields, fieldError(
				base+"/id",
				"invalid_enum_value",
				"Column id is not a supported issue status.",
			))
		} else if _, duplicate := seen[column.ID]; duplicate {
			*fields = append(*fields, fieldError(
				base+"/id",
				"duplicate",
				"Column ids must be unique.",
			))
		}
		seen[column.ID] = struct{}{}
		validateString(fields, base+"/name", column.Name, 1, 50, "Column name")
	}
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
