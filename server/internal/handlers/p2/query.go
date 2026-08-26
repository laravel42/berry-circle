package p2handler

import (
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/handlers/collaboration/shared"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

type searchResource struct {
	Type       string     `json:"type"`
	ID         uuid.UUID  `json:"id"`
	Title      string     `json:"title"`
	Subtitle   *string    `json:"subtitle"`
	Identifier *string    `json:"identifier"`
	BoardID    *uuid.UUID `json:"boardId"`
}

type searchConnection struct {
	Nodes    []searchResource `json:"nodes"`
	PageInfo pageInfo         `json:"pageInfo"`
}

func (handler *handler) search(response http.ResponseWriter, request *http.Request) {
	workspaceID, ok := parseWorkspaceQuery(
		response,
		request,
		"query",
		"types",
		"first",
		"after",
	)
	if !ok {
		return
	}
	query := strings.TrimSpace(request.URL.Query().Get("query"))
	if !validBounded(query, 1, 200) {
		writeValidation(response, request, fieldError(
			"/query/query",
			"out_of_range",
			"query must contain 1 to 200 characters.",
		))
		return
	}
	types := []string{"board", "issue"}
	if raw := request.URL.Query().Get("types"); raw != "" {
		types = strings.Split(raw, ",")
		if len(types) < 1 || len(types) > 2 || !uniqueStrings(types) {
			writeValidation(response, request, fieldError(
				"/query/types",
				"invalid",
				"types must contain unique board and/or issue values.",
			))
			return
		}
		for _, resourceType := range types {
			if resourceType != "board" && resourceType != "issue" {
				writeValidation(response, request, fieldError(
					"/query/types",
					"invalid_enum_value",
					"types must contain only board and issue.",
				))
				return
			}
		}
	}
	sort.Strings(types)
	first, encodedCursor, ok := parsePage(response, request)
	if !ok {
		return
	}
	user := currentUser(request)
	scopeShape := struct {
		WorkspaceID uuid.UUID `json:"workspaceId"`
		UserID      uuid.UUID `json:"userId"`
		Query       string    `json:"query"`
		Types       []string  `json:"types"`
	}{workspaceID, user.ID, strings.ToLower(query), types}
	scope := cursorScope("p2.search", scopeShape)
	var after *p2repo.SearchCursor
	if encodedCursor != "" {
		var cursor p2repo.SearchCursor
		if httpapi.DecodeCursor(encodedCursor, scope, &cursor) != nil ||
			cursor.ID == uuid.Nil || cursor.Rank < 0 ||
			cursor.Normalized == "" ||
			(cursor.ResourceType != "board" && cursor.ResourceType != "issue") {
			writeInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	results, err := handler.service.Search(
		request.Context(),
		user.ID,
		workspaceID,
		p2repo.SearchFilter{
			Query: query,
			Types: types,
			After: after,
			Limit: first + 1,
		},
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(results) > first
	if hasNext {
		results = results[:first]
	}
	nodes := make([]searchResource, 0, len(results))
	for _, result := range results {
		nodes = append(nodes, searchResource{
			Type:       result.Type,
			ID:         result.ID,
			Title:      result.Title,
			Subtitle:   result.Subtitle,
			Identifier: result.Identifier,
			BoardID:    result.BoardID,
		})
	}
	var endCursor *string
	if len(results) > 0 {
		last := results[len(results)-1]
		encoded, err := httpapi.EncodeCursor(scope, p2repo.SearchCursor{
			Rank:         last.Rank,
			Normalized:   last.Normalized,
			ResourceType: last.Type,
			ID:           last.ID,
		})
		if err != nil {
			writeDomainError(response, request, err, "Search")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, searchConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

type issueFilterBody struct {
	BoardIDs     []string `json:"boardIds"`
	Statuses     []string `json:"statuses"`
	Priorities   []string `json:"priorities"`
	AssigneeType *string  `json:"assigneeType"`
	AssigneeID   *string  `json:"assigneeId"`
	AssignedToMe bool     `json:"assignedToMe"`
	Query        *string  `json:"query"`
	CreatedAfter *string  `json:"createdAfter"`
	UpdatedAfter *string  `json:"updatedAfter"`
}

type issueGroupsBody struct {
	WorkspaceID string          `json:"workspaceId"`
	Filter      issueFilterBody `json:"filter"`
	GroupBy     string          `json:"groupBy"`
	First       int             `json:"first"`
	After       string          `json:"after"`
}

type issueRowsBody struct {
	WorkspaceID string          `json:"workspaceId"`
	Filter      issueFilterBody `json:"filter"`
	GroupBy     string          `json:"groupBy"`
	GroupKey    string          `json:"groupKey"`
	First       int             `json:"first"`
	After       string          `json:"after"`
}

type issueFacetsBody struct {
	WorkspaceID string          `json:"workspaceId"`
	Filter      issueFilterBody `json:"filter"`
}

type issueGroupResource struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int64  `json:"count"`
}

type issueGroupConnection struct {
	Nodes    []issueGroupResource `json:"nodes"`
	PageInfo pageInfo             `json:"pageInfo"`
}

type issueRowResource struct {
	ID           uuid.UUID  `json:"id"`
	BoardID      uuid.UUID  `json:"boardId"`
	Identifier   string     `json:"identifier"`
	Title        string     `json:"title"`
	Status       string     `json:"status"`
	Priority     string     `json:"priority"`
	AssigneeType *string    `json:"assigneeType"`
	AssigneeID   *uuid.UUID `json:"assigneeId"`
	DueDate      *string    `json:"dueDate"`
	UpdatedAt    string     `json:"updatedAt"`
}

type issueRowConnection struct {
	Nodes    []issueRowResource `json:"nodes"`
	PageInfo pageInfo           `json:"pageInfo"`
}

func (handler *handler) issueGroups(response http.ResponseWriter, request *http.Request) {
	body, _, ok := decodeJSON[issueGroupsBody](response, request)
	if !ok {
		return
	}
	workspaceID, filter, groupBy, first, fields := parseIssueQueryBody(
		body.WorkspaceID,
		body.Filter,
		body.GroupBy,
		body.First,
	)
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	user := currentUser(request)
	scope := cursorScope("p2.issuegroups", struct {
		WorkspaceID uuid.UUID          `json:"workspaceId"`
		UserID      uuid.UUID          `json:"userId"`
		Filter      p2repo.IssueFilter `json:"filter"`
		GroupBy     string             `json:"groupBy"`
	}{workspaceID, user.ID, filter, groupBy})
	var after *p2repo.IssueGroupCursor
	if body.After != "" {
		var cursor p2repo.IssueGroupCursor
		if httpapi.DecodeCursor(body.After, scope, &cursor) != nil ||
			cursor.Count < 0 || cursor.Key == "" {
			writeInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	groups, err := handler.service.ListIssueGroups(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		groupBy,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(groups) > first
	if hasNext {
		groups = groups[:first]
	}
	nodes := make([]issueGroupResource, 0, len(groups))
	for _, group := range groups {
		nodes = append(nodes, issueGroupResource{
			Key: group.Key, Label: group.Label, Count: group.Count,
		})
	}
	var endCursor *string
	if len(groups) > 0 {
		last := groups[len(groups)-1]
		encoded, err := httpapi.EncodeCursor(scope, p2repo.IssueGroupCursor{
			Count: last.Count,
			Key:   last.Key,
		})
		if err != nil {
			writeDomainError(response, request, err, "Issue groups")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, issueGroupConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

func (handler *handler) issueRows(response http.ResponseWriter, request *http.Request) {
	body, _, ok := decodeJSON[issueRowsBody](response, request)
	if !ok {
		return
	}
	workspaceID, filter, groupBy, first, fields := parseIssueQueryBody(
		body.WorkspaceID,
		body.Filter,
		body.GroupBy,
		body.First,
	)
	if groupBy != "none" && !validBounded(body.GroupKey, 1, 200) {
		fields = append(fields, fieldError(
			"/groupKey",
			"invalid",
			"groupKey is required for grouped rows.",
		))
	}
	if groupBy == "none" && body.GroupKey != "" {
		fields = append(fields, fieldError(
			"/groupKey",
			"invalid",
			"groupKey must be empty when groupBy is none.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	user := currentUser(request)
	scope := cursorScope("p2.issuerows", struct {
		WorkspaceID uuid.UUID          `json:"workspaceId"`
		UserID      uuid.UUID          `json:"userId"`
		Filter      p2repo.IssueFilter `json:"filter"`
		GroupBy     string             `json:"groupBy"`
		GroupKey    string             `json:"groupKey"`
	}{workspaceID, user.ID, filter, groupBy, body.GroupKey})
	var after *p2repo.IssueRowCursor
	if body.After != "" {
		var cursor p2repo.IssueRowCursor
		if httpapi.DecodeCursor(body.After, scope, &cursor) != nil ||
			cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
			writeInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	rows, err := handler.service.ListIssueRows(
		request.Context(),
		user.ID,
		workspaceID,
		filter,
		groupBy,
		body.GroupKey,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(rows) > first
	if hasNext {
		rows = rows[:first]
	}
	nodes := make([]issueRowResource, 0, len(rows))
	for _, row := range rows {
		var dueDate *string
		if row.DueDate != nil {
			value := row.DueDate.UTC().Format(time.RFC3339Nano)
			dueDate = &value
		}
		nodes = append(nodes, issueRowResource{
			ID:           row.ID,
			BoardID:      row.BoardID,
			Identifier:   row.Identifier,
			Title:        row.Title,
			Status:       row.Status,
			Priority:     row.Priority,
			AssigneeType: row.AssigneeType,
			AssigneeID:   row.AssigneeID,
			DueDate:      dueDate,
			UpdatedAt:    row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	var endCursor *string
	if len(rows) > 0 {
		last := rows[len(rows)-1]
		encoded, err := httpapi.EncodeCursor(scope, p2repo.IssueRowCursor{
			UpdatedAt: last.UpdatedAt,
			ID:        last.ID,
		})
		if err != nil {
			writeDomainError(response, request, err, "Issue rows")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, issueRowConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

func (handler *handler) issueFacets(response http.ResponseWriter, request *http.Request) {
	body, _, ok := decodeJSON[issueFacetsBody](response, request)
	if !ok {
		return
	}
	workspaceID, filter, _, _, fields := parseIssueQueryBody(
		body.WorkspaceID,
		body.Filter,
		"none",
		50,
	)
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	facets, err := handler.service.ListIssueFacets(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		filter,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": facets})
}

func parseIssueQueryBody(
	rawWorkspaceID string,
	body issueFilterBody,
	groupBy string,
	first int,
) (uuid.UUID, p2repo.IssueFilter, string, int, []httpapi.FieldError) {
	fields := make([]httpapi.FieldError, 0)
	workspaceID, validWorkspace := parseCanonicalUUID(rawWorkspaceID)
	if !validWorkspace {
		fields = append(fields, fieldError(
			"/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
	}
	if groupBy == "" {
		groupBy = "none"
	}
	if groupBy != "none" && groupBy != "status" && groupBy != "priority" &&
		groupBy != "board" && groupBy != "assignee" {
		fields = append(fields, fieldError(
			"/groupBy",
			"invalid_enum_value",
			"groupBy must be none, status, priority, board, or assignee.",
		))
	}
	if first == 0 {
		first = 50
	}
	if first < 1 || first > 100 {
		fields = append(fields, fieldError(
			"/first",
			"out_of_range",
			"first must be an integer from 1 to 100.",
		))
	}
	filter := p2repo.IssueFilter{AssignedToMe: body.AssignedToMe}
	if len(body.BoardIDs) > 100 {
		fields = append(fields, fieldError(
			"/filter/boardIds",
			"too_big",
			"boardIds may contain at most 100 entries.",
		))
	}
	seenBoards := make(map[uuid.UUID]struct{}, len(body.BoardIDs))
	for index, raw := range body.BoardIDs {
		id, valid := parseCanonicalUUID(raw)
		if !valid {
			fields = append(fields, fieldError(
				"/filter/boardIds/"+strconv.Itoa(index),
				"invalid",
				"Board id must be a canonical UUID.",
			))
			continue
		}
		if _, exists := seenBoards[id]; exists {
			fields = append(fields, fieldError(
				"/filter/boardIds/"+strconv.Itoa(index),
				"duplicate",
				"Board ids must be unique.",
			))
			continue
		}
		seenBoards[id] = struct{}{}
		filter.BoardIDs = append(filter.BoardIDs, id)
	}
	validStatuses := map[string]string{
		"backlog": "backlog", "todo": "todo", "inProgress": "in_progress",
		"inReview": "in_review", "done": "done", "blocked": "blocked", "cancelled": "cancelled",
	}
	for index, status := range body.Statuses {
		mapped, valid := validStatuses[status]
		if !valid {
			fields = append(fields, fieldError(
				"/filter/statuses/"+strconv.Itoa(index),
				"invalid_enum_value",
				"Unsupported issue status.",
			))
		} else {
			filter.Statuses = append(filter.Statuses, mapped)
		}
	}
	if !uniqueStrings(body.Statuses) {
		fields = append(fields, fieldError(
			"/filter/statuses",
			"duplicate",
			"Statuses must be unique.",
		))
	}
	validPriorities := map[string]struct{}{
		"none": {}, "urgent": {}, "high": {}, "medium": {}, "low": {},
	}
	for index, priority := range body.Priorities {
		if _, valid := validPriorities[priority]; !valid {
			fields = append(fields, fieldError(
				"/filter/priorities/"+strconv.Itoa(index),
				"invalid_enum_value",
				"Unsupported issue priority.",
			))
		} else {
			filter.Priorities = append(filter.Priorities, priority)
		}
	}
	if !uniqueStrings(body.Priorities) {
		fields = append(fields, fieldError(
			"/filter/priorities",
			"duplicate",
			"Priorities must be unique.",
		))
	}
	if (body.AssigneeType == nil) != (body.AssigneeID == nil) ||
		body.AssignedToMe && body.AssigneeID != nil {
		fields = append(fields, fieldError(
			"/filter/assigneeId",
			"invalid",
			"assigneeType and assigneeId must be paired and cannot accompany assignedToMe.",
		))
	} else if body.AssigneeType != nil && body.AssigneeID != nil {
		if *body.AssigneeType != "user" && *body.AssigneeType != "agent" {
			fields = append(fields, fieldError(
				"/filter/assigneeType",
				"invalid_enum_value",
				"assigneeType must be user or agent.",
			))
		}
		id, valid := parseCanonicalUUID(*body.AssigneeID)
		if !valid {
			fields = append(fields, fieldError(
				"/filter/assigneeId",
				"invalid",
				"assigneeId must be a canonical UUID.",
			))
		} else {
			filter.AssigneeType = body.AssigneeType
			filter.AssigneeID = &id
		}
	}
	if body.Query != nil {
		value := strings.TrimSpace(*body.Query)
		if !validBounded(value, 1, 200) {
			fields = append(fields, fieldError(
				"/filter/query",
				"out_of_range",
				"query must contain 1 to 200 characters.",
			))
		} else {
			filter.Query = &value
		}
	}
	filter.CreatedAfter = parseFilterTime(
		&fields,
		"/filter/createdAfter",
		body.CreatedAfter,
	)
	filter.UpdatedAfter = parseFilterTime(
		&fields,
		"/filter/updatedAfter",
		body.UpdatedAfter,
	)
	sort.Strings(filter.Statuses)
	sort.Strings(filter.Priorities)
	sort.Slice(filter.BoardIDs, func(left, right int) bool {
		return filter.BoardIDs[left].String() < filter.BoardIDs[right].String()
	})
	return workspaceID, filter, groupBy, first, fields
}

func parseFilterTime(
	fields *[]httpapi.FieldError,
	path string,
	raw *string,
) *time.Time {
	if raw == nil {
		return nil
	}
	value, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		*fields = append(*fields, fieldError(
			path,
			"invalid",
			"Date must be an RFC 3339 timestamp.",
		))
		return nil
	}
	value = value.UTC()
	return &value
}

type batchIssuePatchBody struct {
	Status   *string `json:"status"`
	Priority *string `json:"priority"`
}

type batchIssueUpdateBody struct {
	WorkspaceID string              `json:"workspaceId"`
	IssueIDs    []string            `json:"issueIds"`
	Patch       batchIssuePatchBody `json:"patch"`
}

type batchIssueDeleteBody struct {
	WorkspaceID string   `json:"workspaceId"`
	IssueIDs    []string `json:"issueIds"`
}

func (handler *handler) batchUpdateIssues(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeJSON[batchIssueUpdateBody](response, request)
	if !ok {
		return
	}
	workspaceID, ids, fields := parseBatchIssueIDs(body.WorkspaceID, body.IssueIDs)
	patch := p2repo.BatchIssuePatch{}
	validStatuses := map[string]struct{}{
		"backlog": {}, "todo": {}, "inProgress": {}, "inReview": {},
		"done": {}, "blocked": {}, "cancelled": {},
	}
	if body.Patch.Status != nil {
		if _, valid := validStatuses[*body.Patch.Status]; !valid {
			fields = append(fields, fieldError(
				"/patch/status",
				"invalid_enum_value",
				"Unsupported issue status.",
			))
		} else {
			patch.Status = body.Patch.Status
		}
	}
	validPriorities := map[string]struct{}{
		"none": {}, "urgent": {}, "high": {}, "medium": {}, "low": {},
	}
	if body.Patch.Priority != nil {
		if _, valid := validPriorities[*body.Patch.Priority]; !valid {
			fields = append(fields, fieldError(
				"/patch/priority",
				"invalid_enum_value",
				"Unsupported issue priority.",
			))
		} else {
			patch.Priority = body.Patch.Priority
		}
	}
	if patch.Status == nil && patch.Priority == nil {
		fields = append(fields, fieldError(
			"/patch",
			"too_small",
			"At least one patch field is required.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	results, events, err := handler.service.BatchUpdateIssues(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		ids,
		patch,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	shared.PublishIssue(request.Context(), handler.broadcaster, events)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"results": results})
}

func (handler *handler) batchDeleteIssues(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeJSON[batchIssueDeleteBody](response, request)
	if !ok {
		return
	}
	workspaceID, ids, fields := parseBatchIssueIDs(body.WorkspaceID, body.IssueIDs)
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	results, events, err := handler.service.BatchDeleteIssues(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		ids,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	shared.PublishIssue(request.Context(), handler.broadcaster, events)
	httpapi.WriteJSON(response, http.StatusOK, map[string]any{"results": results})
}

func parseBatchIssueIDs(
	rawWorkspaceID string,
	rawIDs []string,
) (uuid.UUID, []uuid.UUID, []httpapi.FieldError) {
	fields := make([]httpapi.FieldError, 0)
	workspaceID, validWorkspace := parseCanonicalUUID(rawWorkspaceID)
	if !validWorkspace {
		fields = append(fields, fieldError(
			"/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
	}
	if len(rawIDs) < 1 || len(rawIDs) > 100 {
		fields = append(fields, fieldError(
			"/issueIds",
			"out_of_range",
			"issueIds must contain 1 to 100 entries.",
		))
	}
	ids := make([]uuid.UUID, 0, len(rawIDs))
	seen := make(map[uuid.UUID]struct{}, len(rawIDs))
	for index, raw := range rawIDs {
		id, valid := parseCanonicalUUID(raw)
		if !valid {
			fields = append(fields, fieldError(
				"/issueIds/"+strconv.Itoa(index),
				"invalid",
				"Issue id must be a canonical UUID.",
			))
			continue
		}
		if _, exists := seen[id]; exists {
			fields = append(fields, fieldError(
				"/issueIds/"+strconv.Itoa(index),
				"duplicate",
				"Issue ids must be unique.",
			))
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return workspaceID, ids, fields
}
