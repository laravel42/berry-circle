package hooks

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresResolver routes deliveries straight from the connection and
// project tables. It reads no credential column, so it needs no sealer and
// can exist on a deployment where the integrations mount does not.
type PostgresResolver struct {
	Pool *pgxpool.Pool
}

// WorkspaceForAccount implements WorkspaceResolver.
func (resolver PostgresResolver) WorkspaceForAccount(ctx context.Context, provider, externalAccountID string) (uuid.UUID, error) {
	if resolver.Pool == nil {
		return uuid.Nil, errors.New("hooks: no database pool")
	}
	if provider == "" || externalAccountID == "" {
		return uuid.Nil, ErrNoWorkspace
	}
	var workspaceID uuid.UUID
	err := resolver.Pool.QueryRow(
		ctx,
		`SELECT workspace_id FROM integration_connections
		  WHERE provider = $1 AND external_account_id = $2 AND status <> 'disconnected'
		  ORDER BY updated_at DESC, id ASC
		  LIMIT 1`,
		provider, externalAccountID,
	).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoWorkspace
	}
	if err != nil {
		return uuid.Nil, errors.New("hooks: resolve account")
	}
	return workspaceID, nil
}

// WorkspaceForGitHubRepository implements WorkspaceResolver.
func (resolver PostgresResolver) WorkspaceForGitHubRepository(ctx context.Context, repositoryID int64) (uuid.UUID, error) {
	if resolver.Pool == nil {
		return uuid.Nil, errors.New("hooks: no database pool")
	}
	if repositoryID == 0 {
		return uuid.Nil, ErrNoWorkspace
	}
	var workspaceID uuid.UUID
	err := resolver.Pool.QueryRow(
		ctx,
		`SELECT workspace_id FROM projects
		  WHERE github_repo_id = $1 AND deleted_at IS NULL
		  ORDER BY created_at ASC, id ASC
		  LIMIT 1`,
		repositoryID,
	).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoWorkspace
	}
	if err != nil {
		return uuid.Nil, errors.New("hooks: resolve repository")
	}
	return workspaceID, nil
}

// WorkspaceConnected implements WorkspaceResolver.
func (resolver PostgresResolver) WorkspaceConnected(ctx context.Context, workspaceID uuid.UUID, provider string) (bool, error) {
	if resolver.Pool == nil {
		return false, errors.New("hooks: no database pool")
	}
	var connected bool
	if err := resolver.Pool.QueryRow(
		ctx,
		`SELECT EXISTS (
		    SELECT 1 FROM integration_connections
		     WHERE workspace_id = $1 AND provider = $2 AND status = 'connected'
		 )`,
		workspaceID, provider,
	).Scan(&connected); err != nil {
		return false, errors.New("hooks: check connection")
	}
	return connected, nil
}

var _ WorkspaceResolver = PostgresResolver{}
