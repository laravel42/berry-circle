package p2handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

type inboxResource struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspaceId"`
	RecipientID uuid.UUID  `json:"recipientId"`
	EventType   string     `json:"eventType"`
	Category    string     `json:"category"`
	Severity    string     `json:"severity"`
	IssueID     *uuid.UUID `json:"issueId"`
	IssueStatus *string    `json:"issueStatus"`
	// Human identifier for the issue this notification is about, so a client
	// can label the row without joining the issue list — which it cannot do
	// for an issue outside the page it has loaded.
	IssueIdentifier *string         `json:"issueIdentifier"`
	ActorType       *string         `json:"actorType"`
	ActorID         *uuid.UUID      `json:"actorId"`
	Title           string          `json:"title"`
	Body            *string         `json:"body"`
	Details         json.RawMessage `json:"details"`
	Read            bool            `json:"read"`
	Archived        bool            `json:"archived"`
	ReadAt          *string         `json:"readAt"`
	ArchivedAt      *string         `json:"archivedAt"`
	CreatedAt       string          `json:"createdAt"`
	// The aggregate an item is about when it is not (only) an issue.
	ApprovalID    *uuid.UUID `json:"approvalId"`
	GoalID        *uuid.UUID `json:"goalId"`
	WorkflowRunID *uuid.UUID `json:"workflowRunId"`
	PlanID        *uuid.UUID `json:"planId"`
}

type inboxConnection struct {
	Nodes    []inboxResource `json:"nodes"`
	PageInfo pageInfo        `json:"pageInfo"`
}

func serializeInboxItem(item p2repo.InboxItem) inboxResource {
	var readAt, archivedAt *string
	if item.ReadAt != nil {
		value := item.ReadAt.UTC().Format(time.RFC3339Nano)
		readAt = &value
	}
	if item.ArchivedAt != nil {
		value := item.ArchivedAt.UTC().Format(time.RFC3339Nano)
		archivedAt = &value
	}
	return inboxResource{
		ID:          item.ID,
		WorkspaceID: item.WorkspaceID,
		RecipientID: item.RecipientID,
		EventType:   item.EventType,
		Category:    item.Category,
		Severity:    item.Severity,
		IssueID:     item.IssueID,
		IssueStatus: func() *string {
			if item.IssueStatus == nil {
				return nil
			}
			value := databaseStatusToAPI(*item.IssueStatus)
			return &value
		}(),
		IssueIdentifier: item.IssueIdentifier,
		ActorType:       item.ActorType,
		ActorID:         item.ActorID,
		Title:           item.Title,
		Body:            item.Body,
		Details:         item.Details,
		Read:            item.ReadAt != nil,
		Archived:        item.ArchivedAt != nil,
		ReadAt:          readAt,
		ArchivedAt:      archivedAt,
		CreatedAt:       item.CreatedAt.UTC().Format(time.RFC3339Nano),
		ApprovalID:      item.ApprovalID,
		GoalID:          item.GoalID,
		WorkflowRunID:   item.WorkflowRunID,
		PlanID:          item.PlanID,
	}
}

func (handler *handler) listInbox(response http.ResponseWriter, request *http.Request) {
	workspaceID, ok := parseWorkspaceQuery(
		response,
		request,
		"state",
		"unreadOnly",
		"first",
		"after",
	)
	if !ok {
		return
	}
	first, encodedCursor, ok := parsePage(response, request)
	if !ok {
		return
	}
	state := request.URL.Query().Get("state")
	if state == "" {
		state = "active"
	}
	if state != "active" && state != "archived" && state != "all" {
		writeValidation(response, request, fieldError(
			"/query/state",
			"invalid_enum_value",
			"state must be active, archived, or all.",
		))
		return
	}
	unreadOnly := false
	if raw := request.URL.Query().Get("unreadOnly"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil || (raw != "true" && raw != "false") {
			writeValidation(response, request, fieldError(
				"/query/unreadOnly",
				"invalid",
				"unreadOnly must be true or false.",
			))
			return
		}
		unreadOnly = parsed
	}
	user := currentUser(request)
	scope := cursorScope("p2.inbox", struct {
		WorkspaceID uuid.UUID `json:"workspaceId"`
		RecipientID uuid.UUID `json:"recipientId"`
		State       string    `json:"state"`
		UnreadOnly  bool      `json:"unreadOnly"`
	}{workspaceID, user.ID, state, unreadOnly})
	var after *p2repo.InboxCursor
	if encodedCursor != "" {
		var cursor p2repo.InboxCursor
		if httpapi.DecodeCursor(encodedCursor, scope, &cursor) != nil ||
			cursor.ID == uuid.Nil || cursor.CreatedAt.IsZero() {
			writeInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	items, err := handler.service.ListInbox(
		request.Context(),
		user.ID,
		workspaceID,
		p2repo.InboxFilter{
			State:      state,
			UnreadOnly: unreadOnly,
			After:      after,
			Limit:      first + 1,
		},
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(items) > first
	if hasNext {
		items = items[:first]
	}
	nodes := make([]inboxResource, 0, len(items))
	for _, item := range items {
		nodes = append(nodes, serializeInboxItem(item))
	}
	var endCursor *string
	if len(items) > 0 {
		last := items[len(items)-1]
		encoded, err := httpapi.EncodeCursor(scope, p2repo.InboxCursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		})
		if err != nil {
			writeDomainError(response, request, err, "Inbox")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, inboxConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

func (handler *handler) countUnreadInbox(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceQuery(response, request)
	if !ok {
		return
	}
	count, err := handler.service.CountUnreadInbox(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, map[string]int64{"count": count})
}

type workspaceActionBody struct {
	WorkspaceID string `json:"workspaceId"`
}

func (handler *handler) updateInboxItem(
	response http.ResponseWriter,
	request *http.Request,
) {
	action := chi.URLParam(request, "action")
	if action != "read" && action != "unread" &&
		action != "archive" && action != "unarchive" {
		httpapi.WriteError(
			response,
			request,
			http.StatusNotFound,
			"NOT_FOUND",
			"Route not found.",
			nil,
		)
		return
	}
	itemID, ok := parsePathID(
		response,
		request,
		chi.URLParam(request, "itemId"),
		"Inbox item",
	)
	if !ok {
		return
	}
	body, _, ok := decodeJSON[workspaceActionBody](response, request)
	if !ok {
		return
	}
	workspaceID, valid := parseCanonicalUUID(body.WorkspaceID)
	if !valid {
		writeValidation(response, request, fieldError(
			"/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
		return
	}
	item, err := handler.service.UpdateInboxItem(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		itemID,
		action,
	)
	if err != nil {
		writeDomainError(response, request, err, "Inbox item")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeInboxItem(item))
}

type bulkInboxBody struct {
	WorkspaceID string   `json:"workspaceId"`
	Action      string   `json:"action"`
	ItemIDs     []string `json:"itemIds"`
}

type bulkInboxResponse struct {
	UpdatedIDs []uuid.UUID `json:"updatedIds"`
	NotFound   []uuid.UUID `json:"notFoundIds"`
}

func (handler *handler) bulkUpdateInbox(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeJSON[bulkInboxBody](response, request)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	workspaceID, validWorkspace := parseCanonicalUUID(body.WorkspaceID)
	if !validWorkspace {
		fields = append(fields, fieldError(
			"/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
	}
	if body.Action != "read" && body.Action != "unread" &&
		body.Action != "archive" && body.Action != "unarchive" {
		fields = append(fields, fieldError(
			"/action",
			"invalid_enum_value",
			"action must be read, unread, archive, or unarchive.",
		))
	}
	if len(body.ItemIDs) < 1 || len(body.ItemIDs) > 100 {
		fields = append(fields, fieldError(
			"/itemIds",
			"out_of_range",
			"itemIds must contain 1 to 100 entries.",
		))
	}
	ids := make([]uuid.UUID, 0, len(body.ItemIDs))
	seen := make(map[uuid.UUID]struct{}, len(body.ItemIDs))
	for index, raw := range body.ItemIDs {
		id, valid := parseCanonicalUUID(raw)
		if !valid {
			fields = append(fields, fieldError(
				"/itemIds/"+strconv.Itoa(index),
				"invalid",
				"Inbox item id must be a canonical UUID.",
			))
			continue
		}
		if _, exists := seen[id]; exists {
			fields = append(fields, fieldError(
				"/itemIds/"+strconv.Itoa(index),
				"duplicate",
				"Inbox item ids must be unique.",
			))
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	updated, err := handler.service.BulkUpdateInbox(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		ids,
		body.Action,
	)
	if err != nil {
		writeDomainError(response, request, err, "Inbox")
		return
	}
	updatedSet := make(map[uuid.UUID]struct{}, len(updated))
	for _, id := range updated {
		updatedSet[id] = struct{}{}
	}
	orderedUpdated := make([]uuid.UUID, 0, len(updated))
	notFound := make([]uuid.UUID, 0)
	for _, id := range ids {
		if _, exists := updatedSet[id]; exists {
			orderedUpdated = append(orderedUpdated, id)
		} else {
			notFound = append(notFound, id)
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, bulkInboxResponse{
		UpdatedIDs: orderedUpdated,
		NotFound:   notFound,
	})
}

var notificationCategories = []string{
	"assignments",
	"statusChanges",
	"comments",
	"mentions",
	"updates",
	"agentActivity",
	"approvals",
	"goals",
	"workflows",
}

type notificationDocument struct {
	InApp map[string]bool `json:"inApp"`
}

type notificationBody struct {
	WorkspaceID string          `json:"workspaceId"`
	Preferences json.RawMessage `json:"preferences"`
}

type notificationResource struct {
	WorkspaceID uuid.UUID       `json:"workspaceId"`
	UserID      uuid.UUID       `json:"userId"`
	Preferences json.RawMessage `json:"preferences"`
	UpdatedAt   *string         `json:"updatedAt"`
}

func serializeNotificationPreference(
	preference p2repo.NotificationPreferences,
) notificationResource {
	var updatedAt *string
	if preference.UpdatedAt != nil {
		value := preference.UpdatedAt.UTC().Format(time.RFC3339Nano)
		updatedAt = &value
	}
	return notificationResource{
		WorkspaceID: preference.WorkspaceID,
		UserID:      preference.UserID,
		Preferences: preference.Preferences,
		UpdatedAt:   updatedAt,
	}
}

func (handler *handler) getNotificationPreferences(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceQuery(response, request)
	if !ok {
		return
	}
	preference, err := handler.service.GetNotificationPreferences(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(
		response,
		http.StatusOK,
		serializeNotificationPreference(preference),
	)
}

func (handler *handler) putNotificationPreferences(
	response http.ResponseWriter,
	request *http.Request,
) {
	handler.writeNotificationPreferences(response, request, false)
}

func (handler *handler) patchNotificationPreferences(
	response http.ResponseWriter,
	request *http.Request,
) {
	handler.writeNotificationPreferences(response, request, true)
}

func (handler *handler) writeNotificationPreferences(
	response http.ResponseWriter,
	request *http.Request,
	patch bool,
) {
	body, _, ok := decodeJSON[notificationBody](response, request)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	workspaceID, validWorkspace := parseCanonicalUUID(body.WorkspaceID)
	if !validWorkspace {
		fields = append(fields, fieldError(
			"/workspaceId",
			"invalid",
			"workspaceId must be a canonical UUID.",
		))
	}
	var supplied notificationDocument
	var root map[string]json.RawMessage
	validPreferences := validJSONObject(body.Preferences, 32*1024) &&
		json.Unmarshal(body.Preferences, &root) == nil &&
		len(root) == 1
	inApp, hasInApp := root["inApp"]
	if !validPreferences || !hasInApp ||
		json.Unmarshal(inApp, &supplied.InApp) != nil || supplied.InApp == nil {
		fields = append(fields, fieldError(
			"/preferences",
			"invalid_type",
			"preferences must contain only an inApp object.",
		))
	}
	allowed := make(map[string]struct{}, len(notificationCategories))
	for _, category := range notificationCategories {
		allowed[category] = struct{}{}
	}
	for category := range supplied.InApp {
		if _, exists := allowed[category]; !exists {
			fields = append(fields, fieldError(
				"/preferences/inApp/"+category,
				"unknown",
				"Unknown notification category.",
			))
		}
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	next := notificationDocument{InApp: make(map[string]bool, len(notificationCategories))}
	if patch {
		current, err := handler.service.GetNotificationPreferences(
			request.Context(),
			currentUser(request).ID,
			workspaceID,
		)
		if err != nil {
			writeDomainError(response, request, err, "Workspace")
			return
		}
		_ = json.Unmarshal(current.Preferences, &next)
		if next.InApp == nil {
			next.InApp = make(map[string]bool)
		}
	}
	for _, category := range notificationCategories {
		if value, exists := supplied.InApp[category]; exists {
			next.InApp[category] = value
		} else if !patch {
			next.InApp[category] = true
		}
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		writeDomainError(response, request, err, "Notification preferences")
		return
	}
	preference, err := handler.service.PutNotificationPreferences(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		encoded,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(
		response,
		http.StatusOK,
		serializeNotificationPreference(preference),
	)
}

func databaseStatusToAPI(value string) string {
	switch value {
	case "in_progress":
		return "inProgress"
	case "in_review":
		return "inReview"
	default:
		return value
	}
}
