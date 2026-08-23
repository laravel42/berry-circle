package identityhandler

import (
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
)

type invitationResource struct {
	ID          uuid.UUID     `json:"id"`
	WorkspaceID uuid.UUID     `json:"workspaceId"`
	Email       string        `json:"email"`
	Role        identity.Role `json:"role"`
	InvitedBy   uuid.UUID     `json:"invitedBy"`
	ExpiresAt   string        `json:"expiresAt"`
	AcceptedAt  *string       `json:"acceptedAt"`
	RevokedAt   *string       `json:"revokedAt"`
	CreatedAt   string        `json:"createdAt"`
}

type invitationConnection struct {
	Nodes    []invitationResource `json:"nodes"`
	PageInfo pageInfo             `json:"pageInfo"`
}

type invitationIssueResource struct {
	Invitation invitationResource `json:"invitation"`
	Token      *string            `json:"token,omitempty"`
}

func (handlers *handlers) listWorkspaceInvitations(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	scope := "identity.workspace-invitations." + workspaceID.String()
	first, after, ok := parseTimePage(response, request, scope)
	if !ok {
		return
	}
	found, err := handlers.service.ListWorkspaceInvitations(
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
	writeInvitationConnection(response, found, first, scope)
}

type createInvitationBody struct {
	Email     *string        `json:"email"`
	Role      *identity.Role `json:"role"`
	ExpiresAt *string        `json:"expiresAt"`
}

func (handlers *handlers) createInvitation(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	body, raw, ok := decodeBody[createInvitationBody](response, request)
	if !ok {
		return
	}
	key, fingerprint, ok := requireIdempotency(response, request, raw)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	email := ""
	if body.Email == nil {
		fields = append(fields, fieldError("/email", "required", "Email is required."))
	} else {
		email = strings.ToLower(strings.TrimSpace(*body.Email))
		if !validEmail(email) {
			fields = append(fields, fieldError(
				"/email",
				"invalid_string",
				"Email must be a valid address.",
			))
		}
	}
	role := identity.RoleMember
	if body.Role == nil {
		fields = append(fields, fieldError("/role", "required", "Role is required."))
	} else {
		role = *body.Role
		if !role.Valid() || role == identity.RoleOwner {
			fields = append(fields, fieldError(
				"/role",
				"invalid_enum_value",
				"Invitation role must be admin, member, or viewer.",
			))
		}
	}
	now := handlers.clock().UTC()
	expiresAt := now.Add(7 * 24 * time.Hour)
	if body.ExpiresAt != nil {
		parsed, err := time.Parse(time.RFC3339, *body.ExpiresAt)
		if err != nil || !parsed.After(now) || parsed.After(now.Add(30*24*time.Hour)) {
			fields = append(fields, fieldError(
				"/expiresAt",
				"out_of_range",
				"Expiry must be an RFC 3339 time within the next 30 days.",
			))
		} else {
			expiresAt = parsed.UTC()
		}
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	issued, err := handlers.service.CreateInvitation(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		email,
		role,
		expiresAt,
		key,
		fingerprint,
	)
	if err != nil {
		writeDomainError(response, request, err, "Invitation")
		return
	}
	var token *string
	if issued.Token != "" {
		token = &issued.Token
	}
	if issued.Replayed {
		response.Header().Set("Idempotency-Replayed", "true")
	}
	response.Header().Set(
		"Location",
		"/api/v1/workspaces/"+workspaceID.String()+"/invitations/"+
			issued.Invitation.ID.String(),
	)
	httpapi.WriteJSON(response, http.StatusCreated, invitationIssueResource{
		Invitation: serializeInvitation(issued.Invitation),
		Token:      token,
	})
}

func (handlers *handlers) revokeInvitation(
	response http.ResponseWriter,
	request *http.Request,
) {
	workspaceID, ok := workspaceID(response, request)
	if !ok {
		return
	}
	invitationID, ok := parseID(
		response,
		request,
		chi.URLParam(request, "invitationId"),
		"Invitation",
	)
	if !ok {
		return
	}
	if err := handlers.service.RevokeInvitation(
		request.Context(),
		currentUser(request).ID,
		workspaceID,
		invitationID,
	); err != nil {
		writeDomainError(response, request, err, "Invitation")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func (handlers *handlers) listPersonalInvitations(
	response http.ResponseWriter,
	request *http.Request,
) {
	user := currentUser(request)
	scope := "identity.personal-invitations." + user.ID.String()
	first, after, ok := parseTimePage(response, request, scope)
	if !ok {
		return
	}
	found, err := handlers.service.ListPersonalInvitations(
		request.Context(),
		user.ID,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Invitation")
		return
	}
	writeInvitationConnection(response, found, first, scope)
}

type acceptInvitationBody struct {
	Token *string `json:"token"`
}

func (handlers *handlers) acceptInvitation(
	response http.ResponseWriter,
	request *http.Request,
) {
	invitationID, ok := parseID(
		response,
		request,
		chi.URLParam(request, "invitationId"),
		"Invitation",
	)
	if !ok {
		return
	}
	body, raw, ok := decodeBody[acceptInvitationBody](response, request)
	if !ok {
		return
	}
	if _, _, ok := requireIdempotency(response, request, raw); !ok {
		return
	}
	if body.Token == nil || !validBounded(*body.Token, 53, 53) {
		writeValidation(response, request, fieldError(
			"/token",
			"invalid",
			"Invitation token is invalid.",
		))
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	member, err := handlers.service.AcceptInvitation(
		request.Context(),
		currentUser(request).ID,
		invitationID,
		*body.Token,
	)
	if err != nil {
		writeDomainError(response, request, err, "Invitation")
		return
	}
	httpapi.WriteJSON(response, http.StatusOK, serializeMember(member))
}

func writeInvitationConnection(
	response http.ResponseWriter,
	found []identity.Invitation,
	first int,
	scope string,
) {
	hasNext := len(found) > first
	if hasNext {
		found = found[:first]
	}
	nodes := make([]invitationResource, 0, len(found))
	for _, invitation := range found {
		nodes = append(nodes, serializeInvitation(invitation))
	}
	httpapi.WriteJSON(response, http.StatusOK, invitationConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   timeEndCursor(scope, found),
		},
	})
}

func serializeInvitation(invitation identity.Invitation) invitationResource {
	return invitationResource{
		ID:          invitation.ID,
		WorkspaceID: invitation.WorkspaceID,
		Email:       invitation.Email,
		Role:        invitation.Role,
		InvitedBy:   invitation.InvitedBy,
		ExpiresAt:   invitation.ExpiresAt.UTC().Format(time.RFC3339Nano),
		AcceptedAt:  formatOptionalTime(invitation.AcceptedAt),
		RevokedAt:   formatOptionalTime(invitation.RevokedAt),
		CreatedAt:   invitation.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

type personalTokenResource struct {
	ID         uuid.UUID `json:"id"`
	Name       string    `json:"name"`
	Prefix     string    `json:"prefix"`
	ExpiresAt  *string   `json:"expiresAt"`
	LastUsedAt *string   `json:"lastUsedAt"`
	RevokedAt  *string   `json:"revokedAt"`
	CreatedAt  string    `json:"createdAt"`
}

type personalTokenConnection struct {
	Nodes    []personalTokenResource `json:"nodes"`
	PageInfo pageInfo                `json:"pageInfo"`
}

type personalTokenIssueResource struct {
	PersonalToken personalTokenResource `json:"personalToken"`
	Token         *string               `json:"token,omitempty"`
}

type createPersonalTokenBody struct {
	Name      *string `json:"name"`
	ExpiresAt *string `json:"expiresAt"`
}

func (handlers *handlers) createPersonalToken(
	response http.ResponseWriter,
	request *http.Request,
) {
	body, raw, ok := decodeBody[createPersonalTokenBody](response, request)
	if !ok {
		return
	}
	key, fingerprint, ok := requireIdempotency(response, request, raw)
	if !ok {
		return
	}
	fields := make([]httpapi.FieldError, 0)
	name := ""
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
	var expiresAt *time.Time
	if body.ExpiresAt != nil {
		now := handlers.clock().UTC()
		parsed, err := time.Parse(time.RFC3339, *body.ExpiresAt)
		if err != nil || !parsed.After(now) || parsed.After(now.Add(365*24*time.Hour)) {
			fields = append(fields, fieldError(
				"/expiresAt",
				"out_of_range",
				"Expiry must be an RFC 3339 time within the next 365 days.",
			))
		} else {
			value := parsed.UTC()
			expiresAt = &value
		}
	}
	if len(fields) > 0 {
		writeValidation(response, request, fields...)
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	issued, err := handlers.service.CreatePersonalToken(
		request.Context(),
		currentUser(request).ID,
		name,
		expiresAt,
		key,
		fingerprint,
	)
	if err != nil {
		writeDomainError(response, request, err, "Personal token")
		return
	}
	var secret *string
	if issued.Secret != "" {
		secret = &issued.Secret
	}
	if issued.Replayed {
		response.Header().Set("Idempotency-Replayed", "true")
	}
	response.Header().Set("Location", "/api/v1/tokens/"+issued.Token.ID.String())
	httpapi.WriteJSON(response, http.StatusCreated, personalTokenIssueResource{
		PersonalToken: serializePersonalToken(issued.Token),
		Token:         secret,
	})
}

func (handlers *handlers) listPersonalTokens(
	response http.ResponseWriter,
	request *http.Request,
) {
	user := currentUser(request)
	scope := "identity.tokens." + user.ID.String()
	first, after, ok := parseTimePage(response, request, scope)
	if !ok {
		return
	}
	found, err := handlers.service.ListPersonalTokens(
		request.Context(),
		user.ID,
		after,
		first+1,
	)
	if err != nil {
		writeDomainError(response, request, err, "Personal token")
		return
	}
	hasNext := len(found) > first
	if hasNext {
		found = found[:first]
	}
	nodes := make([]personalTokenResource, 0, len(found))
	for _, token := range found {
		nodes = append(nodes, serializePersonalToken(token))
	}
	httpapi.WriteJSON(response, http.StatusOK, personalTokenConnection{
		Nodes: nodes,
		PageInfo: pageInfo{
			HasNextPage: hasNext,
			EndCursor:   timeEndCursor(scope, found),
		},
	})
}

func (handlers *handlers) revokePersonalToken(
	response http.ResponseWriter,
	request *http.Request,
) {
	tokenID, ok := parseID(
		response,
		request,
		chi.URLParam(request, "tokenId"),
		"Personal token",
	)
	if !ok {
		return
	}
	if !requireEmptyBody(response, request) {
		return
	}
	if err := handlers.service.RevokePersonalToken(
		request.Context(),
		currentUser(request).ID,
		tokenID,
	); err != nil {
		writeDomainError(response, request, err, "Personal token")
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func serializePersonalToken(token identity.PersonalToken) personalTokenResource {
	return personalTokenResource{
		ID:         token.ID,
		Name:       token.Name,
		Prefix:     token.Prefix,
		ExpiresAt:  formatOptionalTime(token.ExpiresAt),
		LastUsedAt: formatOptionalTime(token.LastUsedAt),
		RevokedAt:  formatOptionalTime(token.RevokedAt),
		CreatedAt:  token.CreatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func formatOptionalTime(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
