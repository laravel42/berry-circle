package p2handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

type savedViewResource struct {
	ID                uuid.UUID       `json:"id"`
	WorkspaceID       uuid.UUID       `json:"workspaceId"`
	OwnerID           uuid.UUID       `json:"ownerId"`
	Name              string          `json:"name"`
	Visibility        string          `json:"visibility"`
	DefinitionVersion int             `json:"definitionVersion"`
	Query             json.RawMessage `json:"query"`
	Display           json.RawMessage `json:"display"`
	Revision          int             `json:"revision"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
}

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type savedViewConnection struct {
	Nodes    []savedViewResource `json:"nodes"`
	PageInfo pageInfo            `json:"pageInfo"`
}

func serializeSavedView(view p2repo.SavedView) savedViewResource {
	return savedViewResource{
		ID:                view.ID,
		WorkspaceID:       view.WorkspaceID,
		OwnerID:           view.OwnerID,
		Name:              view.Name,
		Visibility:        view.Visibility,
		DefinitionVersion: view.DefinitionVersion,
		Query:             view.Query,
		Display:           view.Display,
		Revision:          view.Revision,
		CreatedAt:         view.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:         view.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (handler *handler) listSavedViews(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceQuery(response, request, "first", "after")
	if !ok {
		return
	}
	first, encodedCursor, ok := parsePage(response, request)
	if !ok {
		return
	}
	user := currentUser(request)
	scope := cursorScope("p2.views", struct {
		WorkspaceID uuid.UUID `json:"workspaceId"`
		UserID      uuid.UUID `json:"userId"`
	}{workspaceID, user.ID})
	var after *p2repo.SavedViewCursor
	if encodedCursor != "" {
		var cursor p2repo.SavedViewCursor
		if httpapi.DecodeCursor(encodedCursor, scope, &cursor) != nil ||
			cursor.ID == uuid.Nil || cursor.UpdatedAt.IsZero() {
			writeInvalidCursor(response, request)
			return
		}
		after = &cursor
	}
	views, err := handler.service.ListSavedViews(
		request.Context(),
		user.ID,
		workspaceID,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(views) > first
	if hasNext {
		views = views[:first]
	}
	nodes := make([]savedViewResource, 0, len(views))
	for _, view := range views {
		nodes = append(nodes, serializeSavedView(view))
	}
	var endCursor *string
	if len(views) > 0 {
		last := views[len(views)-1]
		encoded, err := httpapi.EncodeCursor(scope, p2repo.SavedViewCursor{
			UpdatedAt: last.UpdatedAt,
			ID:        last.ID,
		})
		if err != nil {
			writeDomainError(response, request, err, "Saved view")
			return
		}
		endCursor = &encoded
	}
	httpapi.WriteJSON(response, http.StatusOK, savedViewConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

type createSavedViewBody struct {
	WorkspaceID       string          `json:"workspaceId"`
	Name              string          `json:"name"`
	Visibility        string          `json:"visibility"`
	DefinitionVersion int             `json:"definitionVersion"`
	Query             json.RawMessage `json:"query"`
	Display           json.RawMessage `json:"display"`
}

func (handler *handler) createSavedView(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, _, ok := decodeJSON[createSavedViewBody](response, request)
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
	body.Name = strings.TrimSpace(body.Name)
	if !validBounded(body.Name, 1, 80) {
		fields = append(fields, fieldError(
			"/name",
			"out_of_range",
			"name must contain 1 to 80 characters.",
		))
	}
	if body.Visibility == "" {
		body.Visibility = "private"
	}
	if body.Visibility != "private" && body.Visibility != "workspace" {
		fields = append(fields, fieldError(
			"/visibility",
			"invalid_enum_value",
			"visibility must be private or workspace.",
		))
	}
	if body.DefinitionVersion == 0 {
		body.DefinitionVersion = 1
	}
	if body.DefinitionVersion < 1 || body.DefinitionVersion > 1000 {
		fields = append(fields, fieldError(
			"/definitionVersion",
			"out_of_range",
			"definitionVersion must be from 1 to 1000.",
		))
	}
	if !validJSONObject(body.Query, 64*1024) {
		fields = append(fields, fieldError(
			"/query",
			"invalid_type",
			"query must be a JSON object no larger than 64 KiB.",
		))
	}
	if len(body.Display) == 0 {
		body.Display = json.RawMessage(`{}`)
	}
	if !validJSONObject(body.Display, 32*1024) {
		fields = append(fields, fieldError(
			"/display",
			"invalid_type",
			"display must be a JSON object no larger than 32 KiB.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	view, err := handler.service.CreateSavedView(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		body.Name,
		body.Visibility,
		body.DefinitionVersion,
		body.Query,
		body.Display,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	response.Header().Set("Location", "/api/v1/views/"+view.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, serializeSavedView(view))
}

func (handler *handler) getSavedView(response http.ResponseWriter, request *http.Request) {
	workspaceID, ok := parseWorkspaceQuery(response, request)
	if !ok {
		return
	}
	viewID, ok := parsePathID(
		response,
		request,
		chi.URLParam(request, "viewId"),
		"Saved view",
	)
	if !ok {
		return
	}
	view, err := handler.service.GetSavedView(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		viewID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Saved view")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeSavedView(view))
}

type updateSavedViewBody struct {
	Name             *string         `json:"name"`
	Visibility       *string         `json:"visibility"`
	Query            json.RawMessage `json:"query"`
	Display          json.RawMessage `json:"display"`
	ExpectedRevision int             `json:"expectedRevision"`
}

func (handler *handler) updateSavedView(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceQuery(response, request)
	if !ok {
		return
	}
	viewID, ok := parsePathID(
		response,
		request,
		chi.URLParam(request, "viewId"),
		"Saved view",
	)
	if !ok {
		return
	}
	body, _, ok := decodeJSON[updateSavedViewBody](response, request)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	if body.Name != nil {
		trimmed := strings.TrimSpace(*body.Name)
		body.Name = &trimmed
		if !validBounded(trimmed, 1, 80) {
			fields = append(fields, fieldError(
				"/name",
				"out_of_range",
				"name must contain 1 to 80 characters.",
			))
		}
	}
	if body.Visibility != nil &&
		*body.Visibility != "private" && *body.Visibility != "workspace" {
		fields = append(fields, fieldError(
			"/visibility",
			"invalid_enum_value",
			"visibility must be private or workspace.",
		))
	}
	if len(body.Query) > 0 && !validJSONObject(body.Query, 64*1024) {
		fields = append(fields, fieldError(
			"/query",
			"invalid_type",
			"query must be a JSON object no larger than 64 KiB.",
		))
	}
	if len(body.Display) > 0 && !validJSONObject(body.Display, 32*1024) {
		fields = append(fields, fieldError(
			"/display",
			"invalid_type",
			"display must be a JSON object no larger than 32 KiB.",
		))
	}
	if body.ExpectedRevision < 1 {
		fields = append(fields, fieldError(
			"/expectedRevision",
			"invalid",
			"expectedRevision must be a positive integer.",
		))
	}
	if body.Name == nil && body.Visibility == nil &&
		len(body.Query) == 0 && len(body.Display) == 0 {
		fields = append(fields, fieldError(
			"/",
			"too_small",
			"At least one mutable field must be provided.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	view, err := handler.service.UpdateSavedView(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		viewID,
		body.Name,
		body.Visibility,
		body.Query,
		body.Display,
		body.ExpectedRevision,
	)
	if err != nil {
		writeDomainError(response, request, err, "Saved view")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeSavedView(view))
}

func (handler *handler) deleteSavedView(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := parseWorkspaceQuery(response, request)
	if !ok {
		return
	}
	viewID, ok := parsePathID(
		response,
		request,
		chi.URLParam(request, "viewId"),
		"Saved view",
	)
	if !ok {
		return
	}
	err := handler.service.DeleteSavedView(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		viewID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Saved view")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

type viewPreferenceResource struct {
	WorkspaceID uuid.UUID       `json:"workspaceId"`
	UserID      uuid.UUID       `json:"userId"`
	ActiveView  *uuid.UUID      `json:"activeViewId"`
	Preferences json.RawMessage `json:"preferences"`
	UpdatedAt   *string         `json:"updatedAt"`
}

func serializeViewPreference(preference p2repo.ViewPreference) viewPreferenceResource {
	var updatedAt *string
	if preference.UpdatedAt != nil {
		value := preference.UpdatedAt.UTC().Format(time.RFC3339Nano)
		updatedAt = &value
	}
	return viewPreferenceResource{
		WorkspaceID: preference.WorkspaceID,
		UserID:      preference.UserID,
		ActiveView:  preference.ActiveView,
		Preferences: preference.Preferences,
		UpdatedAt:   updatedAt,
	}
}

type putViewPreferenceBody struct {
	WorkspaceID  string          `json:"workspaceId"`
	ActiveViewID *string         `json:"activeViewId"`
	Preferences  json.RawMessage `json:"preferences"`
}

type pinResource struct {
	ID          uuid.UUID `json:"id"`
	WorkspaceID uuid.UUID `json:"workspaceId"`
	UserID      uuid.UUID `json:"userId"`
	TargetType  string    `json:"targetType"`
	TargetID    uuid.UUID `json:"targetId"`
	Position    int       `json:"position"`
	CreatedAt   string    `json:"createdAt"`
}

func serializePin(pin p2repo.Pin) pinResource {
	return pinResource{
		ID:          pin.ID,
		WorkspaceID: pin.WorkspaceID,
		UserID:      pin.UserID,
		TargetType:  pin.TargetType,
		TargetID:    pin.TargetID,
		Position:    pin.Position,
		CreatedAt:   pin.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

type createPinBody struct {
	WorkspaceID string `json:"workspaceId"`
	TargetType  string `json:"targetType"`
	TargetID    string `json:"targetId"`
}

type reorderPinsBody struct {
	WorkspaceID string   `json:"workspaceId"`
	PinIDs      []string `json:"pinIds"`
}
