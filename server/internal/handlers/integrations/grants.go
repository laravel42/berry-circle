package integrations

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

type grantResource struct {
	AgentID   *uuid.UUID `json:"agentId"`
	Provider  string     `json:"provider"`
	Tool      string     `json:"tool"`
	MaxEffect string     `json:"maxEffect"`
}

func listGrantsHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsRead)
		if !ok {
			return
		}
		grants, err := options.Store.ListGrants(request.Context(), workspaceID)
		if err != nil {
			writeInternal(response, request, options, "list grants", err)
			return
		}
		resources := make([]grantResource, 0, len(grants))
		for _, grant := range grants {
			resources = append(resources, grantResource{
				AgentID:   grant.AgentID,
				Provider:  grant.Provider,
				Tool:      grant.Tool,
				MaxEffect: string(grant.MaxEffect),
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"grants": resources})
	}
}

type grantRequest struct {
	AgentID   *string `json:"agentId"`
	Provider  string  `json:"provider"`
	Tool      string  `json:"tool"`
	MaxEffect string  `json:"maxEffect"`
}

// decodeGrant reads and validates a grant from the request body.
//
// The tool is checked against the registry rather than accepted as a string.
// A grant naming a tool no provider offers is not harmless: it would sit in
// settings looking like policy while authorising nothing, and a later provider
// release that happened to use the name would activate it retroactively.
func decodeGrant(
	response http.ResponseWriter,
	request *http.Request,
	options Options,
	workspaceID uuid.UUID,
	requireEffect bool,
) (core.Grant, bool) {
	var body grantRequest
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 4<<10)).Decode(&body); err != nil {
		httpapi.WriteError(response, request, http.StatusBadRequest,
			"INVALID_BODY", "The request body could not be read.", nil)
		return core.Grant{}, false
	}

	provider, ok := options.Registry.Get(strings.ToLower(strings.TrimSpace(body.Provider)))
	if !ok {
		httpapi.WriteError(response, request, http.StatusBadRequest,
			"UNKNOWN_PROVIDER", "Unknown integration provider.", nil)
		return core.Grant{}, false
	}
	tool := strings.TrimSpace(body.Tool)
	if tool != core.Wildcard && !providerOffers(provider, tool) {
		httpapi.WriteError(response, request, http.StatusBadRequest,
			"UNKNOWN_TOOL", "That provider does not offer this tool.", nil)
		return core.Grant{}, false
	}

	grant := core.Grant{
		WorkspaceID: workspaceID,
		Provider:    provider.ID(),
		Tool:        tool,
	}
	if body.AgentID != nil && strings.TrimSpace(*body.AgentID) != "" {
		agentID, err := uuid.Parse(strings.TrimSpace(*body.AgentID))
		if err != nil {
			httpapi.WriteError(response, request, http.StatusBadRequest,
				"INVALID_AGENT", "That agent id is not valid.", nil)
			return core.Grant{}, false
		}
		grant.AgentID = &agentID
	}

	if requireEffect {
		effect := core.Effect(strings.TrimSpace(body.MaxEffect))
		if !effect.Valid() {
			httpapi.WriteError(response, request, http.StatusBadRequest,
				"INVALID_EFFECT", "That is not a valid effect level.", nil)
			return core.Grant{}, false
		}
		grant.MaxEffect = effect
	}
	return grant, true
}

func providerOffers(provider core.Provider, tool string) bool {
	for _, candidate := range provider.Tools() {
		if candidate.Name == tool {
			return true
		}
	}
	return false
}

// setGrantHandler creates or changes one permission.
func setGrantHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsWrite)
		if !ok {
			return
		}
		grant, ok := decodeGrant(response, request, options, workspaceID, true)
		if !ok {
			return
		}
		if err := options.Store.SetGrant(request.Context(), grant, options.Clock()); err != nil {
			writeInternal(response, request, options, "set grant", err)
			return
		}
		httpapi.WriteJSON(response, http.StatusOK, grantResource{
			AgentID:   grant.AgentID,
			Provider:  grant.Provider,
			Tool:      grant.Tool,
			MaxEffect: string(grant.MaxEffect),
		})
	}
}

func revokeGrantHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsWrite)
		if !ok {
			return
		}
		grant, ok := decodeGrant(response, request, options, workspaceID, false)
		if !ok {
			return
		}
		if err := options.Store.RevokeGrant(
			request.Context(), workspaceID, grant.AgentID, grant.Provider, grant.Tool,
		); err != nil {
			writeInternal(response, request, options, "revoke grant", err)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	}
}

type auditResource struct {
	ID            uuid.UUID  `json:"id"`
	AgentID       *uuid.UUID `json:"agentId"`
	UserID        *uuid.UUID `json:"userId"`
	RunID         *uuid.UUID `json:"runId"`
	Provider      string     `json:"provider"`
	Tool          string     `json:"tool"`
	Effect        string     `json:"effect"`
	InputSummary  string     `json:"inputSummary,omitempty"`
	ResultSummary string     `json:"resultSummary,omitempty"`
	Status        string     `json:"status"`
	Approval      string     `json:"approvalStatus"`
	ExternalIDs   []string   `json:"externalIds"`
	ExternalURL   string     `json:"externalUrl,omitempty"`
	ErrorCode     string     `json:"errorCode,omitempty"`
	StartedAt     time.Time  `json:"startedAt"`
	CompletedAt   *time.Time `json:"completedAt,omitempty"`
	DurationMS    *int64     `json:"durationMs,omitempty"`
}

// listAuditHandler returns recent integration activity.
//
// The audit is settings-read rather than product-read: it names what agents did
// in connected accounts, which is operational detail, not board content.
func listAuditHandler(options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		workspaceID, _, ok := workspaceFor(response, request, options, identity.PermissionSettingsRead)
		if !ok {
			return
		}
		limit := 50
		if raw := strings.TrimSpace(request.URL.Query().Get("limit")); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed <= 0 {
				httpapi.WriteError(response, request, http.StatusBadRequest,
					"INVALID_LIMIT", "The limit must be a positive number.", nil)
				return
			}
			limit = parsed
		}
		records, err := options.Store.ListAudit(request.Context(), workspaceID, limit)
		if err != nil {
			writeInternal(response, request, options, "list audit", err)
			return
		}
		resources := make([]auditResource, 0, len(records))
		for _, record := range records {
			resources = append(resources, auditResource{
				ID: record.ID, AgentID: record.AgentID, UserID: record.UserID,
				RunID: record.RunID, Provider: record.Provider, Tool: record.Tool,
				Effect: string(record.Effect), InputSummary: record.InputSummary,
				ResultSummary: record.ResultSummary, Status: record.Status,
				Approval: record.Approval, ExternalIDs: record.ExternalIDs,
				ExternalURL: record.ExternalURL, ErrorCode: record.ErrorCode,
				StartedAt: record.StartedAt, CompletedAt: record.CompletedAt,
				DurationMS: record.DurationMS,
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"events": resources})
	}
}
