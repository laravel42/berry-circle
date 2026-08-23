package identityhandler

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

type pageInfo struct {
	HasNextPage bool    `json:"hasNextPage"`
	EndCursor   *string `json:"endCursor"`
}

type workspaceResource struct {
	ID          uuid.UUID                  `json:"id"`
	Name        string                     `json:"name"`
	Slug        string                     `json:"slug"`
	Description *string                    `json:"description"`
	Settings    identity.WorkspaceSettings `json:"settings"`
	Role        identity.Role              `json:"role"`
	CreatedAt   string                     `json:"createdAt"`
	UpdatedAt   string                     `json:"updatedAt"`
}

type workspaceConnection struct {
	Nodes    []workspaceResource `json:"nodes"`
	PageInfo pageInfo            `json:"pageInfo"`
}

func (handlers *handlers) listWorkspaces(
	response http.ResponseWriter,
	request *http.Request,
) {
	user := currentUser(request)
	first, after, ok := parseTimePage(
		response,
		request,
		"identity.workspaces."+user.ID.String(),
	)
	if !ok {
		return
	}
	found, err := handlers.service.ListWorkspaces(
		request.Context(),
		user.ID,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(found) > first
	if hasNext {
		found = found[:first]
	}
	nodes := make([]workspaceResource, 0, len(found))
	for _, workspace := range found {
		nodes = append(nodes, serializeWorkspace(workspace))
	}
	httpapi.WriteJSON(response, http.StatusOK, workspaceConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   timeEndCursor("identity.workspaces."+user.ID.String(), found),
		},
	})
}

type createWorkspaceBody struct {
	Name        *string         `json:"name"`
	Slug        *string         `json:"slug"`
	Description json.RawMessage `json:"description"`
}

func (handlers *handlers) createWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, raw, ok := decodeBody[createWorkspaceBody](response, request)
	if !ok {
		return
	}
	key, fingerprint, ok := requireIdempotency(response, request, raw)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	var name, slug string
	if body.Name == nil {
		fields = append(fields, fieldError("/name", "required", "Name is required."))
	} else {
		name = strings.TrimSpace(*body.Name)
		if !validBounded(name, 1, 100) {
			fields = append(fields, fieldError(
				"/name",
				"invalid_length",
				"Name must contain 1 to 100 characters.",
			))
		}
	}
	if body.Slug == nil {
		fields = append(fields, fieldError("/slug", "required", "Slug is required."))
	} else {
		slug = strings.ToLower(strings.TrimSpace(*body.Slug))
		if !validWorkspaceSlug(slug) {
			fields = append(fields, fieldError(
				"/slug",
				"invalid_format",
				"Slug must contain 2 to 50 lowercase letters, digits, or hyphens.",
			))
		}
	}
	description, descriptionSet, descriptionError := parseNullableString(
		body.Description,
		5000,
	)
	if descriptionError != nil {
		fields = append(fields, fieldError(
			"/description",
			"invalid_length",
			"Description must be null or at most 5,000 characters.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	if !descriptionSet {
		description = nil
	}
	workspace, replayed, err := handlers.service.CreateWorkspace(
		request.Context(),
		currentUser(request).ID,
		name,
		slug,
		description,
		key,
		fingerprint,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	if replayed {
		response.Header().Set("Idempotency-Replayed", "true")
	}
	response.Header().Set("Location", "/api/v1/workspaces/"+workspace.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, serializeWorkspace(workspace))
}

func (handlers *handlers) getWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	workspace, err := handlers.service.GetWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeWorkspace(workspace))
}

type workspacePatchBody struct {
	Name        *string         `json:"name"`
	Slug        *string         `json:"slug"`
	Description json.RawMessage `json:"description"`
}

func (handlers *handlers) updateWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	body, _, ok := decodeBody[workspacePatchBody](response, request)
	if !ok {
		return
	}
	patch := identity.WorkspacePatch{}
	fields := make([]httpapi.FieldError, 0)
	if body.Name != nil {
		value := strings.TrimSpace(*body.Name)
		if !validBounded(value, 1, 100) {
			fields = append(fields, fieldError(
				"/name",
				"invalid_length",
				"Name must contain 1 to 100 characters.",
			))
		} else {
			patch.Name = &value
		}
	}
	if body.Slug != nil {
		value := strings.ToLower(strings.TrimSpace(*body.Slug))
		if !validWorkspaceSlug(value) {
			fields = append(fields, fieldError(
				"/slug",
				"invalid_format",
				"Slug must contain 2 to 50 lowercase letters, digits, or hyphens.",
			))
		} else {
			patch.Slug = &value
		}
	}
	description, descriptionSet, descriptionError := parseNullableString(
		body.Description,
		5000,
	)
	if descriptionError != nil {
		fields = append(fields, fieldError(
			"/description",
			"invalid_length",
			"Description must be null or at most 5,000 characters.",
		))
	} else if descriptionSet {
		patch.DescriptionSet = true
		patch.Description = description
	}
	if patch.Name == nil && patch.Slug == nil && !patch.DescriptionSet {
		fields = append(fields, fieldError(
			"/",
			"empty_patch",
			"At least one workspace field is required.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	workspace, err := handlers.service.UpdateWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		patch,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeWorkspace(workspace))
}

func (handlers *handlers) deleteWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	if err := handlers.service.DeleteWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	); err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handlers *handlers) selectWorkspace(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	if !requireEmptyBody(response, request) {
		return
	}
	if err := handlers.service.SelectWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	); err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	workspace, err := handlers.service.GetWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeWorkspace(workspace))
}

func (handlers *handlers) getWorkspaceSettings(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	workspace, err := handlers.service.GetWorkspace(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, workspace.Settings)
}

type workspaceSettingsPatchBody struct {
	IssuePrefix        *string        `json:"issuePrefix"`
	DefaultRole        *identity.Role `json:"defaultRole"`
	AllowMemberInvites *bool          `json:"allowMemberInvites"`
}

func (handlers *handlers) updateWorkspaceSettings(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	body, _, ok := decodeBody[workspaceSettingsPatchBody](response, request)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	if body.IssuePrefix != nil {
		value := strings.ToUpper(strings.TrimSpace(*body.IssuePrefix))
		body.IssuePrefix = &value
		if !validIssuePrefix(value) {
			fields = append(fields, fieldError(
				"/issuePrefix",
				"invalid_format",
				"Issue prefix must contain 2 to 12 uppercase letters or digits.",
			))
		}
	}
	if body.DefaultRole != nil &&
		(*body.DefaultRole != identity.RoleMember &&
			*body.DefaultRole != identity.RoleViewer) {
		fields = append(fields, fieldError(
			"/defaultRole",
			"invalid_enum_value",
			"Default role must be member or viewer.",
		))
	}
	if body.IssuePrefix == nil && body.DefaultRole == nil &&
		body.AllowMemberInvites == nil {
		fields = append(fields, fieldError(
			"/",
			"empty_patch",
			"At least one workspace setting is required.",
		))
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	settings, err := handlers.service.UpdateWorkspaceSettings(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		identity.WorkspaceSettingsPatch{
			IssuePrefix:        body.IssuePrefix,
			DefaultRole:        body.DefaultRole,
			AllowMemberInvites: body.AllowMemberInvites,
		},
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, settings)
}

type memberResource struct {
	UserID      uuid.UUID     `json:"userId"`
	WorkspaceID uuid.UUID     `json:"workspaceId"`
	Role        identity.Role `json:"role"`
	Email       string        `json:"email"`
	Name        string        `json:"name"`
	AvatarURL   *string       `json:"avatarUrl"`
	JoinedAt    string        `json:"joinedAt"`
	UpdatedAt   string        `json:"updatedAt"`
}

type memberConnection struct {
	Nodes    []memberResource `json:"nodes"`
	PageInfo pageInfo         `json:"pageInfo"`
}

func (handlers *handlers) listMembers(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	scope := "identity.members." + workspaceID.String()
	first, after, ok := parseNamePage(response, request, scope)
	if !ok {
		return
	}
	found, err := handlers.service.ListMembers(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Workspace")
		return
	}
	hasNext := len(found) > first
	if hasNext {
		found = found[:first]
	}
	nodes := make([]memberResource, 0, len(found))
	for _, member := range found {
		nodes = append(nodes, serializeMember(member))
	}
	var endCursor *string
	if len(found) > 0 {
		last := found[len(found)-1]
		encoded, err := httpapi.EncodeCursor(scope, identity.NameCursor{
			Name: last.Name,
			ID:   last.UserID,
		})
		if err == nil {
			endCursor = &encoded
		}
	}
	httpapi.WriteJSON(response, http.StatusOK, memberConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   endCursor,
		},
	})
}

type memberRolePatchBody struct {
	Role *identity.Role `json:"role"`
}

func (handlers *handlers) updateMemberRole(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	targetID, ok := parseID(
		response,
		request,
		chi.URLParam(request, "userId"),
		"Member",
	)
	if !ok {
		return
	}
	body, _, ok := decodeBody[memberRolePatchBody](response, request)
	if !ok {
		return
	}
	if body.Role == nil || !body.Role.Valid() {
		writeValidation(response, request, fieldError(
			"/role",
			"invalid_enum_value",
			"Role must be owner, admin, member, or viewer.",
		))
		return
	}
	member, err := handlers.service.UpdateMemberRole(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		targetID,
		*body.Role,
	)
	if err != nil {
		writeDomainError(response, request, err, "Member")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeMember(member))
}

func (handlers *handlers) removeMember(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	targetID, ok := parseID(
		response,
		request,
		chi.URLParam(request, "userId"),
		"Member",
	)
	if !ok {
		return
	}
	if err := handlers.service.RemoveMember(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		targetID,
	); err != nil {
		writeDomainError(response, request, err, "Member")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func workspaceID(
	response http.ResponseWriter,
	request *http.Request,
) (uuid.UUID, bool) {
	return parseID(
		response,
		request,
		chi.URLParam(request, "workspaceId"),
		"Workspace",
	)
}

func serializeWorkspace(workspace identity.Workspace) workspaceResource {
	return workspaceResource{
		ID:          workspace.ID,
		Name:        workspace.Name,
		Slug:        workspace.Slug,
		Description: workspace.Description,
		Settings:    workspace.Settings,
		Role:        workspace.Role,
		CreatedAt:   workspace.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   workspace.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func serializeMember(member identity.Membership) memberResource {
	return memberResource{
		UserID:      member.UserID,
		WorkspaceID: member.WorkspaceID,
		Role:        member.Role,
		Email:       member.Email,
		Name:        member.Name,
		AvatarURL:   member.AvatarURL,
		JoinedAt:    member.JoinedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:   member.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func timeEndCursor[T interface {
	identity.Workspace | identity.Invitation | identity.PersonalToken
}](scope string, values []T) *string {
	if len(values) == 0 {
		return nil
	}
	var cursor identity.TimeCursor
	switch value := any(values[len(values)-1]).(type) {
	case identity.Workspace:
		cursor = identity.TimeCursor{CreatedAt: value.CreatedAt, ID: value.ID}
	case identity.Invitation:
		cursor = identity.TimeCursor{CreatedAt: value.CreatedAt, ID: value.ID}
	case identity.PersonalToken:
		cursor = identity.TimeCursor{CreatedAt: value.CreatedAt, ID: value.ID}
	}
	encoded, err := httpapi.EncodeCursor(scope, cursor)
	if err != nil {
		return nil
	}
	return &encoded
}

func parseNullableString(
	raw json.RawMessage,
	maximum int,
) (*string, bool, error) {
	if raw == nil {
		return nil, false, nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, true, err
	}
	value = strings.TrimSpace(value)
	if !validBounded(value, 0, maximum) {
		return nil, true, errors.New("string is too long")
	}
	return &value, true, nil
}

func requireEmptyBody(
	response http.ResponseWriter,
	request *http.Request,
) bool {
	body, err := io.ReadAll(http.MaxBytesReader(response, request.Body, 1024))
	if err != nil {
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
	if len(bytes.TrimSpace(body)) != 0 {
		writeValidation(response, request, fieldError(
			"/",
			"unrecognized_body",
			"This operation does not accept a request body.",
		))
		return false
	}
	return true
}
