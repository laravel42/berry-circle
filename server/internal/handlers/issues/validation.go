package issues

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
)

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

type assigneeBody struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type createIssueBody struct {
	BoardID     optional[string]       `json:"boardId"`
	Title       optional[string]       `json:"title"`
	Description optional[string]       `json:"description"`
	Status      optional[string]       `json:"status"`
	Priority    optional[string]       `json:"priority"`
	SortOrder   optional[int32]        `json:"sortOrder"`
	DueDate     optional[string]       `json:"dueDate"`
	Assignee    optional[assigneeBody] `json:"assignee"`
}

type updateIssueBody struct {
	Title       optional[string]       `json:"title"`
	Description optional[string]       `json:"description"`
	Status      optional[string]       `json:"status"`
	Priority    optional[string]       `json:"priority"`
	SortOrder   optional[int32]        `json:"sortOrder"`
	DueDate     optional[string]       `json:"dueDate"`
	Assignee    optional[assigneeBody] `json:"assignee"`
}

type createIssueInput struct {
	BoardID     uuid.UUID
	Title       string
	Description *string
	Status      string
	Priority    string
	SortOrder   int32
	DueDate     *time.Time
	Assignee    *core.AssigneeInput
}

type issueQuery struct {
	First      int
	After      string
	BoardID    uuid.UUID
	Statuses   []string
	Priorities []string
	Assignee   *core.AssigneeInput
	Query      *string
}

var (
	validIssueStatuses = map[string]string{
		"backlog":    "backlog",
		"todo":       "todo",
		"inProgress": "in_progress",
		"inReview":   "in_review",
		"done":       "done",
		"blocked":    "blocked",
		"cancelled":  "cancelled",
	}
	validIssuePriorities = map[string]struct{}{
		"none": {}, "urgent": {}, "high": {}, "medium": {}, "low": {},
	}
)

func parseCreateIssue(
	response http.ResponseWriter,
	request *http.Request,
) (createIssueInput, bool) {
	var body createIssueBody
	if !decodeIssueJSON(response, request, &body) {
		return createIssueInput{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	var boardID uuid.UUID
	if !body.BoardID.Set || body.BoardID.Null {
		fields = append(fields, issueFieldError("/boardId", "invalid_type", "Field is required."))
	} else if parsed, err := core.ParseUUID(body.BoardID.Value); err != nil {
		fields = append(fields, issueFieldError("/boardId", "invalid_string", "boardId must be a UUID."))
	} else {
		boardID = parsed
	}
	title := ""
	if !body.Title.Set || body.Title.Null {
		fields = append(fields, issueFieldError("/title", "invalid_type", "Field is required."))
	} else {
		title = strings.TrimSpace(body.Title.Value)
		validateIssueString(&fields, "/title", title, 1, 500, "Title")
	}
	var description *string
	if body.Description.Set && !body.Description.Null {
		if utf8.RuneCountInString(body.Description.Value) > 100000 {
			fields = append(fields, issueFieldError(
				"/description",
				"too_big",
				"Description must contain at most 100000 characters.",
			))
		}
		description = &body.Description.Value
	}
	status := "backlog"
	if body.Status.Set {
		if body.Status.Null {
			fields = append(fields, issueFieldError("/status", "invalid_type", "Status cannot be null."))
		} else if mapped, ok := validIssueStatuses[body.Status.Value]; !ok {
			fields = append(fields, issueFieldError(
				"/status",
				"invalid_enum_value",
				"Status is not supported.",
			))
		} else {
			status = mapped
		}
	}
	priority := "none"
	if body.Priority.Set {
		if body.Priority.Null {
			fields = append(fields, issueFieldError(
				"/priority",
				"invalid_type",
				"Priority cannot be null.",
			))
		} else if _, ok := validIssuePriorities[body.Priority.Value]; !ok {
			fields = append(fields, issueFieldError(
				"/priority",
				"invalid_enum_value",
				"Priority is not supported.",
			))
		} else {
			priority = body.Priority.Value
		}
	}
	sortOrder := int32(0)
	if body.SortOrder.Set {
		if body.SortOrder.Null {
			fields = append(fields, issueFieldError(
				"/sortOrder",
				"invalid_type",
				"sortOrder cannot be null.",
			))
		} else {
			sortOrder = body.SortOrder.Value
		}
	}
	dueDate := parseOptionalDate(&fields, "/dueDate", body.DueDate)
	assignee := parseOptionalAssignee(&fields, body.Assignee)
	if len(fields) > 0 {
		writeIssueValidation(response, request, fields...)
		return createIssueInput{}, false
	}
	return createIssueInput{
		BoardID:     boardID,
		Title:       title,
		Description: description,
		Status:      status,
		Priority:    priority,
		SortOrder:   sortOrder,
		DueDate:     dueDate,
		Assignee:    assignee,
	}, true
}

func parseIssuePatch(
	response http.ResponseWriter,
	request *http.Request,
) (core.IssuePatch, bool) {
	var body updateIssueBody
	if !decodeIssueJSON(response, request, &body) {
		return core.IssuePatch{}, false
	}
	fields := make([]httpapi.FieldError, 0)
	patch := core.IssuePatch{}
	count := 0
	if body.Title.Set {
		count++
		if body.Title.Null {
			fields = append(fields, issueFieldError("/title", "invalid_type", "Title cannot be null."))
		} else {
			title := strings.TrimSpace(body.Title.Value)
			validateIssueString(&fields, "/title", title, 1, 500, "Title")
			patch.Title = &title
		}
	}
	if body.Description.Set {
		count++
		patch.DescriptionSet = true
		if !body.Description.Null {
			if utf8.RuneCountInString(body.Description.Value) > 100000 {
				fields = append(fields, issueFieldError(
					"/description",
					"too_big",
					"Description must contain at most 100000 characters.",
				))
			}
			patch.Description = &body.Description.Value
		}
	}
	if body.Status.Set {
		count++
		if body.Status.Null {
			fields = append(fields, issueFieldError("/status", "invalid_type", "Status cannot be null."))
		} else if status, ok := validIssueStatuses[body.Status.Value]; !ok {
			fields = append(fields, issueFieldError(
				"/status",
				"invalid_enum_value",
				"Status is not supported.",
			))
		} else {
			patch.Status = &status
		}
	}
	if body.Priority.Set {
		count++
		if body.Priority.Null {
			fields = append(fields, issueFieldError(
				"/priority",
				"invalid_type",
				"Priority cannot be null.",
			))
		} else if _, ok := validIssuePriorities[body.Priority.Value]; !ok {
			fields = append(fields, issueFieldError(
				"/priority",
				"invalid_enum_value",
				"Priority is not supported.",
			))
		} else {
			patch.Priority = &body.Priority.Value
		}
	}
	if body.SortOrder.Set {
		count++
		if body.SortOrder.Null {
			fields = append(fields, issueFieldError(
				"/sortOrder",
				"invalid_type",
				"sortOrder cannot be null.",
			))
		} else {
			patch.SortOrder = &body.SortOrder.Value
		}
	}
	if body.DueDate.Set {
		count++
		patch.DueDateSet = true
		patch.DueDate = parseOptionalDate(&fields, "/dueDate", body.DueDate)
	}
	if body.Assignee.Set {
		count++
		patch.AssigneeSet = true
		patch.Assignee = parseOptionalAssignee(&fields, body.Assignee)
	}
	if count == 0 {
		fields = append(fields, issueFieldError(
			"/",
			"too_small",
			"At least one field must be provided.",
		))
	}
	if len(fields) > 0 {
		writeIssueValidation(response, request, fields...)
		return core.IssuePatch{}, false
	}
	return patch, true
}

func parseIssueQuery(
	response http.ResponseWriter,
	request *http.Request,
) (issueQuery, bool) {
	query := request.URL.Query()
	allowed := map[string]struct{}{
		"first": {}, "after": {}, "boardId": {}, "status": {},
		"priority": {}, "assigneeType": {}, "assigneeId": {}, "query": {},
	}
	for name, values := range query {
		if _, ok := allowed[name]; !ok || len(values) != 1 {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
	}
	result := issueQuery{First: 50}
	if raw := query.Get("first"); raw != "" {
		first, err := strconv.Atoi(raw)
		if err != nil || first < 1 || first > 100 {
			writeInvalidIssueQuery(response, request, []httpapi.FieldError{issueFieldError(
				"/query/first",
				"invalid",
				"first must be an integer from 1 to 100.",
			)})
			return issueQuery{}, false
		}
		result.First = first
	}
	result.After = query.Get("after")
	if _, present := query["after"]; present && result.After == "" {
		writeIssueInvalidCursor(response, request)
		return issueQuery{}, false
	}
	boardID, err := core.ParseUUID(query.Get("boardId"))
	if err != nil {
		writeInvalidIssueQuery(response, request, []httpapi.FieldError{issueFieldError(
			"/query/boardId",
			"invalid_string",
			"boardId must be a UUID.",
		)})
		return issueQuery{}, false
	}
	result.BoardID = boardID
	if raw, present := query["status"]; present {
		values, ok := parseCSV(raw[0])
		if !ok {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
		for _, value := range values {
			mapped, valid := validIssueStatuses[value]
			if !valid {
				writeInvalidIssueQuery(response, request, nil)
				return issueQuery{}, false
			}
			result.Statuses = append(result.Statuses, mapped)
		}
		sort.Strings(result.Statuses)
	}
	if raw, present := query["priority"]; present {
		values, ok := parseCSV(raw[0])
		if !ok {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
		for _, value := range values {
			if _, valid := validIssuePriorities[value]; !valid {
				writeInvalidIssueQuery(response, request, nil)
				return issueQuery{}, false
			}
			result.Priorities = append(result.Priorities, value)
		}
		sort.Strings(result.Priorities)
	}
	assigneeType, hasType := query["assigneeType"]
	assigneeID, hasID := query["assigneeId"]
	if hasType != hasID {
		writeInvalidIssueQuery(response, request, nil)
		return issueQuery{}, false
	}
	if hasType {
		if assigneeType[0] != "user" && assigneeType[0] != "agent" {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
		id, err := core.ParseUUID(assigneeID[0])
		if err != nil {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
		result.Assignee = &core.AssigneeInput{Type: assigneeType[0], ID: id}
	}
	if raw, present := query["query"]; present {
		length := utf8.RuneCountInString(raw[0])
		if length < 1 || length > 200 {
			writeInvalidIssueQuery(response, request, nil)
			return issueQuery{}, false
		}
		value := core.EscapeSearchLiteral(raw[0])
		result.Query = &value
	}
	return result, true
}

func parseOptionalDate(
	fields *[]httpapi.FieldError,
	path string,
	value optional[string],
) *time.Time {
	if !value.Set || value.Null {
		return nil
	}
	parsed, err := time.Parse(time.RFC3339, value.Value)
	if err != nil {
		*fields = append(*fields, issueFieldError(
			path,
			"invalid_string",
			"Date must be an RFC 3339 timestamp.",
		))
		return nil
	}
	parsed = parsed.UTC()
	return &parsed
}

func parseOptionalAssignee(
	fields *[]httpapi.FieldError,
	value optional[assigneeBody],
) *core.AssigneeInput {
	if !value.Set || value.Null {
		return nil
	}
	if value.Value.Type != "user" && value.Value.Type != "agent" {
		*fields = append(*fields, issueFieldError(
			"/assignee/type",
			"invalid_enum_value",
			"Assignee type must be user or agent.",
		))
	}
	id, err := core.ParseUUID(value.Value.ID)
	if err != nil {
		*fields = append(*fields, issueFieldError(
			"/assignee/id",
			"invalid_string",
			"Assignee id must be a UUID.",
		))
	}
	if err != nil || (value.Value.Type != "user" && value.Value.Type != "agent") {
		return nil
	}
	return &core.AssigneeInput{Type: value.Value.Type, ID: id}
}

func decodeIssueJSON(
	response http.ResponseWriter,
	request *http.Request,
	target any,
) bool {
	request.Body = http.MaxBytesReader(response, request.Body, maxIssueBodyBytes)
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
			writeIssueInvalidJSON(response, request)
			return false
		}
		writeIssueValidation(response, request, issueFieldError(
			"/",
			"invalid_type",
			"The request body contains an unknown field or invalid value.",
		))
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeIssueInvalidJSON(response, request)
		return false
	}
	return true
}

func parseCSV(raw string) ([]string, bool) {
	parts := strings.Split(raw, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, false
		}
		values = append(values, part)
	}
	return values, len(values) > 0
}

func validateIssueString(
	fields *[]httpapi.FieldError,
	path, value string,
	minimum, maximum int,
	label string,
) {
	length := utf8.RuneCountInString(value)
	if length < minimum {
		*fields = append(*fields, issueFieldError(
			path,
			"too_small",
			label+" must contain at least "+strconv.Itoa(minimum)+" character.",
		))
	}
	if length > maximum {
		*fields = append(*fields, issueFieldError(
			path,
			"too_big",
			label+" must contain at most "+strconv.Itoa(maximum)+" characters.",
		))
	}
}

func issueFieldError(path, code, message string) httpapi.FieldError {
	return httpapi.FieldError{Path: path, Code: code, Message: message}
}

func writeIssueValidation(
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

func writeIssueInvalidJSON(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request body is not valid JSON.",
		nil,
	)
}

func writeIssueInvalidCursor(response http.ResponseWriter, request *http.Request) {
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_CURSOR",
		"The pagination cursor is invalid.",
		nil,
	)
}

func writeInvalidIssueQuery(
	response http.ResponseWriter,
	request *http.Request,
	fields []httpapi.FieldError,
) {
	var details any
	if len(fields) > 0 {
		details = httpapi.ValidationDetails{Fields: fields}
	}
	httpapi.WriteError(
		response,
		request,
		http.StatusBadRequest,
		"INVALID_REQUEST",
		"The request query is invalid.",
		details,
	)
}
