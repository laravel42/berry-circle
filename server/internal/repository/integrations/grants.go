package integrations

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
)

// wildcardAgent is the sentinel the unique index folds a NULL agent onto.
//
// Postgres treats NULLs as distinct in a unique index, so without this a
// workspace-wide grant could be inserted twice and "revoke" would leave one
// behind. The value is the nil UUID, which no real agent can hold.
const wildcardAgent = "00000000-0000-0000-0000-000000000000"

// GrantsFor returns the grants that could authorise a call.
//
// Implements core.GrantStore. Both agent-specific and workspace-wide rows come
// back; the authorizer decides which apply. Filtering to "this agent or no
// agent" happens in SQL so a grant naming a different agent never reaches the
// decision at all.
func (repository *Repository) GrantsFor(
	ctx context.Context,
	workspaceID uuid.UUID,
	agentID *uuid.UUID,
	provider string,
) ([]core.Grant, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT workspace_id, agent_id, provider, tool, max_effect
		   FROM integration_permissions
		  WHERE workspace_id = $1
		    AND provider = $2
		    AND (agent_id IS NULL OR agent_id = $3)`,
		workspaceID, provider, agentID,
	)
	if err != nil {
		return nil, fmt.Errorf("load grants: %w", err)
	}
	defer rows.Close()

	grants := make([]core.Grant, 0, 8)
	for rows.Next() {
		var (
			grant  core.Grant
			effect string
		)
		if err := rows.Scan(
			&grant.WorkspaceID, &grant.AgentID, &grant.Provider, &grant.Tool, &effect,
		); err != nil {
			return nil, fmt.Errorf("scan grant: %w", err)
		}
		grant.MaxEffect = core.Effect(effect)
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

// ListGrants returns every grant in a workspace, for the settings screen.
func (repository *Repository) ListGrants(
	ctx context.Context,
	workspaceID uuid.UUID,
) ([]core.Grant, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT workspace_id, agent_id, provider, tool, max_effect
		   FROM integration_permissions
		  WHERE workspace_id = $1
		  ORDER BY provider, tool, agent_id NULLS FIRST`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list grants: %w", err)
	}
	defer rows.Close()

	grants := make([]core.Grant, 0, 16)
	for rows.Next() {
		var (
			grant  core.Grant
			effect string
		)
		if err := rows.Scan(
			&grant.WorkspaceID, &grant.AgentID, &grant.Provider, &grant.Tool, &effect,
		); err != nil {
			return nil, fmt.Errorf("scan grant: %w", err)
		}
		grant.MaxEffect = core.Effect(effect)
		grants = append(grants, grant)
	}
	return grants, rows.Err()
}

// SetGrant creates or raises a permission.
//
// The effect is validated here rather than left to the column constraint so the
// caller gets a usable error, and so an unknown effect cannot be written by a
// future provider that invents one.
func (repository *Repository) SetGrant(
	ctx context.Context,
	grant core.Grant,
	now time.Time,
) error {
	if !grant.MaxEffect.Valid() {
		return fmt.Errorf("integrations: %q is not a valid effect", grant.MaxEffect)
	}
	if grant.Tool == "" {
		return errors.New("integrations: grant tool is required")
	}
	_, err := repository.Pool.Exec(
		ctx,
		`INSERT INTO integration_permissions (
			workspace_id, agent_id, provider, tool, max_effect, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$6)
		 ON CONFLICT (workspace_id, COALESCE(agent_id, '`+wildcardAgent+`'::uuid), provider, tool)
		 DO UPDATE SET max_effect = EXCLUDED.max_effect, updated_at = EXCLUDED.updated_at`,
		grant.WorkspaceID, grant.AgentID, grant.Provider, grant.Tool,
		string(grant.MaxEffect), now.UTC(),
	)
	if err != nil {
		return fmt.Errorf("set grant: %w", err)
	}
	return nil
}

// RevokeGrant removes a permission. Revoking one that does not exist is not an
// error: the caller's intent — "this agent must not have this" — already holds.
func (repository *Repository) RevokeGrant(
	ctx context.Context,
	workspaceID uuid.UUID,
	agentID *uuid.UUID,
	provider, tool string,
) error {
	_, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM integration_permissions
		  WHERE workspace_id = $1
		    AND COALESCE(agent_id, '`+wildcardAgent+`'::uuid)
		        = COALESCE($2::uuid, '`+wildcardAgent+`'::uuid)
		    AND provider = $3 AND tool = $4`,
		workspaceID, agentID, provider, tool,
	)
	if err != nil {
		return fmt.Errorf("revoke grant: %w", err)
	}
	return nil
}

// RevokeProvider removes every grant for a provider in a workspace.
//
// Called when a connection is dropped. Leaving grants behind would mean that
// reconnecting a different account silently re-armed permissions nobody
// reviewed for it.
func (repository *Repository) RevokeProvider(
	ctx context.Context,
	workspaceID uuid.UUID,
	provider string,
) error {
	_, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM integration_permissions WHERE workspace_id = $1 AND provider = $2`,
		workspaceID, provider,
	)
	if err != nil {
		return fmt.Errorf("revoke provider grants: %w", err)
	}
	return nil
}

// ApplyDefaultGrants grants a newly connected provider's opt-out tools.
//
// Only tools the provider marks EnabledByDefault, which by construction
// excludes anything destructive. Everything else stays absent, and absence
// denies — so connecting an account never silently arms a dangerous tool.
func (repository *Repository) ApplyDefaultGrants(
	ctx context.Context,
	workspaceID uuid.UUID,
	provider core.Provider,
	now time.Time,
) (int, error) {
	granted := 0
	for _, tool := range provider.Tools() {
		if !tool.EnabledByDefault {
			continue
		}
		grant := core.Grant{
			WorkspaceID: workspaceID,
			Provider:    provider.ID(),
			Tool:        tool.Name,
			MaxEffect:   tool.Effect,
		}
		if err := repository.SetGrant(ctx, grant, now); err != nil {
			return granted, err
		}
		granted++
	}
	return granted, nil
}
