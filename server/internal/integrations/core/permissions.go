package core

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// Wildcard grants every tool a provider offers, at the grant's effect ceiling.
const Wildcard = "*"

// Grant is one stored permission row.
type Grant struct {
	WorkspaceID uuid.UUID
	// AgentID nil means the grant applies to every agent in the workspace.
	AgentID   *uuid.UUID
	Provider  string
	Tool      string
	MaxEffect Effect
}

// GrantStore reads the grants that apply to an execution.
type GrantStore interface {
	// GrantsFor returns every grant matching the workspace and provider, both
	// agent-specific and workspace-wide.
	GrantsFor(ctx context.Context, workspaceID uuid.UUID, agentID *uuid.UUID, provider string) ([]Grant, error)
}

// ConnectionStore reads the connection a call would run through.
type ConnectionStore interface {
	Connection(ctx context.Context, workspaceID uuid.UUID, provider string) (Connection, error)
}

// ErrNoConnection means the workspace has not connected the provider.
var ErrNoConnection = errors.New("integrations: provider is not connected")

// PermissionAuthorizer decides calls from stored grants and connection state.
//
// Deny is the default at every step: no connection, no grant, a grant too weak,
// or an unusable connection all refuse. Nothing here can return Allowed on a
// path that did not explicitly find a matching grant.
type PermissionAuthorizer struct {
	Grants      GrantStore
	Connections ConnectionStore
}

// Authorize implements Authorizer.
func (authorizer PermissionAuthorizer) Authorize(
	ctx context.Context,
	exec ExecutionContext,
	tool Tool,
) (Decision, error) {
	if authorizer.Grants == nil || authorizer.Connections == nil {
		return Decision{}, errors.New("integrations: authorizer is not configured")
	}
	if exec.WorkspaceID == uuid.Nil {
		return Decision{Reason: "no workspace in context"}, nil
	}
	if !tool.Effect.Valid() {
		return Decision{Reason: "tool has no valid effect classification"}, nil
	}

	// The connection is checked first and by workspace, so a tool can never run
	// against another workspace's account: the only credential reachable is the
	// one this workspace connected.
	connection, err := authorizer.Connections.Connection(ctx, exec.WorkspaceID, tool.Provider)
	switch {
	case errors.Is(err, ErrNoConnection):
		return Decision{Reason: fmt.Sprintf("%s is not connected for this workspace", tool.Provider)}, nil
	case err != nil:
		return Decision{}, err
	}
	if !connection.Status.Usable() {
		return Decision{Reason: fmt.Sprintf("%s connection is %s", tool.Provider, connection.Status)}, nil
	}

	grants, err := authorizer.Grants.GrantsFor(ctx, exec.WorkspaceID, exec.AgentID, tool.Provider)
	if err != nil {
		return Decision{}, err
	}

	for _, grant := range grants {
		if grant.Provider != tool.Provider {
			continue
		}
		if grant.Tool != tool.Name && grant.Tool != Wildcard {
			continue
		}
		// An agent-specific grant and a workspace-wide one are both acceptable,
		// but a grant naming a different agent is not this agent's to use.
		if grant.AgentID != nil && (exec.AgentID == nil || *grant.AgentID != *exec.AgentID) {
			continue
		}
		if !tool.Effect.AtMost(grant.MaxEffect) {
			continue
		}
		return Decision{
			Allowed:          true,
			RequiresApproval: tool.RequiresApproval,
		}, nil
	}

	return Decision{
		Reason: fmt.Sprintf("no grant permits %s at effect %s", tool.Name, tool.Effect),
	}, nil
}
