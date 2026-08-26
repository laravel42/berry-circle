package agents

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	"github.com/laravel42/berry-circle/server/internal/openfang"
)

// CapabilityStore reads the registry view of a workspace's agents.
type CapabilityStore interface {
	ListCapabilities(context.Context, uuid.UUID) ([]AgentCapability, error)
}

// MaxConcurrentRunsPerAgent is the one-writer rule: an agent works one issue
// at a time, so eligibility is "has no active run".
const MaxConcurrentRunsPerAgent = 1

type availabilityResource struct {
	Eligible          bool `json:"eligible"`
	ActiveRuns        int  `json:"activeRuns"`
	MaxConcurrentRuns int  `json:"maxConcurrentRuns"`
}

// capabilityResource is what the planner reads about an agent (spec §20):
// Berry-authored skills, runtime tools, availability, manifest limits.
type capabilityResource struct {
	ID             uuid.UUID             `json:"id"`
	Name           string                `json:"name"`
	Status         string                `json:"status"`
	Capabilities   []string              `json:"capabilities"`
	Tools          []string              `json:"tools"`
	Repositories   []string              `json:"repositories"`
	Availability   availabilityResource  `json:"availability"`
	Limits         *openfang.AgentLimits `json:"limits"`
	CostProfile    *string               `json:"costProfile"`
	IsOrchestrator bool                  `json:"isOrchestrator"`
	UpdatedAt      string                `json:"updatedAt"`
}

// capabilitiesHandler serves GET /capabilities for the caller's workspace.
// It reads the stored projection rather than the runtime: the list route
// reconciles, and a planner call must not pay one runtime round trip per
// agent.
func capabilitiesHandler(store CapabilityStore, options Options) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		user := auth.MustUser(request.Context())
		if user.CurrentWorkspaceID == nil {
			writeWorkspaceNotFound(response, request)
			return
		}
		workspaceID := *user.CurrentWorkspaceID
		if _, err := options.Authorization.AuthorizeWorkspace(
			request.Context(), user.ID, workspaceID, identity.PermissionRead,
		); !writeAgentAuthorization(response, request, err, true) {
			return
		}
		found, err := store.ListCapabilities(request.Context(), workspaceID)
		if err != nil {
			writeInternal(response, request)
			return
		}
		nodes := make([]capabilityResource, 0, len(found))
		for _, item := range found {
			tools := append([]string(nil), item.Agent.Capabilities...)
			if tools == nil {
				tools = []string{}
			}
			skills := append([]string(nil), item.Agent.Skills...)
			if skills == nil {
				skills = []string{}
			}
			eligible := (item.Agent.Status == "available" || item.Agent.Status == "busy") &&
				item.ActiveRuns < MaxConcurrentRunsPerAgent
			var costProfile *string
			if item.Agent.ModelTier != nil {
				costProfile = item.Agent.ModelTier
			}
			nodes = append(nodes, capabilityResource{
				ID:           item.Agent.ID,
				Name:         item.Agent.Name,
				Status:       item.Agent.Status,
				Capabilities: skills,
				Tools:        tools,
				Repositories: []string{},
				Availability: availabilityResource{
					Eligible: eligible, ActiveRuns: item.ActiveRuns, MaxConcurrentRuns: MaxConcurrentRunsPerAgent,
				},
				Limits:         item.Agent.ManifestLimits,
				CostProfile:    costProfile,
				IsOrchestrator: item.Protected,
				UpdatedAt:      item.Agent.UpdatedAt.UTC().Format(time.RFC3339Nano),
			})
		}
		httpapi.WriteJSON(response, http.StatusOK, map[string]any{"nodes": nodes})
	}
}
