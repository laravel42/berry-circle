// Package integrations owns the persistence behind Berry's native provider
// connections: who connected what, which agents may use it, and what was done.
//
// The runtime executes provider calls through MCP; Berry never proxies them.
// What Berry owns is the part MCP has no concept of — workspace scoping,
// per-agent authorisation, and an audit trail — plus custody of the credential
// that makes any of it possible.
//
// Credentials are the reason this package exists as a boundary. They arrive
// sealed by internal/secrets and are opened in exactly one method, Credential.
// Every other read path omits the token columns from its SELECT, so a value
// this package hands out cannot carry a secret even if a caller logs it.
package integrations

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/secrets"
)

// Repository is the hand-written pgx boundary for integrations.
type Repository struct {
	Pool   *pgxpool.Pool
	Sealer secrets.Sealer
}

// New validates the dependencies this repository cannot work without.
//
// The sealer is required rather than optional: a nil one would mean writing
// credentials in the clear, and the failure would be silent. Refusing at
// construction turns that into a startup error instead.
func New(pool *pgxpool.Pool, sealer secrets.Sealer) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("integration repository pool is nil")
	}
	if sealer == nil {
		return nil, errors.New("integration repository sealer is nil")
	}
	return &Repository{Pool: pool, Sealer: sealer}, nil
}

var (
	// ErrNotFound means no such connection, grant or audit row.
	ErrNotFound = errors.New("integrations: not found")
	// ErrNoCredential means the connection exists but holds no usable token —
	// a connection recorded before authorisation completed, or one whose
	// credential was cleared on revocation.
	ErrNoCredential = errors.New("integrations: connection has no credential")
)

// connectionColumns deliberately excludes the two token columns.
//
// Kept as one constant so a future column is added in one place and the
// omission stays visible: anyone adding `access_token_encrypted` here has to
// notice they are widening what a Connection can carry.
const connectionColumns = `
	id, workspace_id, provider, connected_by_user_id,
	coalesce(external_account_id, ''), coalesce(external_account_name, ''),
	expires_at, scopes, metadata, status, coalesce(status_detail, ''),
	created_at, updated_at`

func scanConnection(row pgx.Row) (core.Connection, error) {
	var connection core.Connection
	var status string
	err := row.Scan(
		&connection.ID, &connection.WorkspaceID, &connection.Provider,
		&connection.ConnectedByUserID,
		&connection.ExternalAccountID, &connection.ExternalAccountName,
		&connection.ExpiresAt, &connection.Scopes, &connection.Metadata,
		&status, &connection.StatusDetail,
		&connection.CreatedAt, &connection.UpdatedAt,
	)
	if err != nil {
		return core.Connection{}, err
	}
	connection.Status = core.ConnectionStatus(status)
	return connection, nil
}

// Connection returns the workspace's live connection for a provider.
//
// Implements core.ConnectionStore. A disconnected row is not a connection: it
// is retained only so audit history can still name it, and returning it would
// let an authorisation check pass on an account nobody is linked to any more.
func (repository *Repository) Connection(
	ctx context.Context,
	workspaceID uuid.UUID,
	provider string,
) (core.Connection, error) {
	row := repository.Pool.QueryRow(
		ctx,
		`SELECT`+connectionColumns+`
		   FROM integration_connections
		  WHERE workspace_id = $1 AND provider = $2 AND status <> 'disconnected'`,
		workspaceID, provider,
	)
	connection, err := scanConnection(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return core.Connection{}, core.ErrNoConnection
	}
	if err != nil {
		return core.Connection{}, fmt.Errorf("load %s connection: %w", provider, err)
	}
	return connection, nil
}

// ListConnections returns every live connection in a workspace, for settings.
func (repository *Repository) ListConnections(
	ctx context.Context,
	workspaceID uuid.UUID,
) ([]core.Connection, error) {
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT`+connectionColumns+`
		   FROM integration_connections
		  WHERE workspace_id = $1 AND status <> 'disconnected'
		  ORDER BY provider`,
		workspaceID,
	)
	if err != nil {
		return nil, fmt.Errorf("list connections: %w", err)
	}
	defer rows.Close()

	connections := make([]core.Connection, 0, 5)
	for rows.Next() {
		connection, err := scanConnection(rows)
		if err != nil {
			return nil, fmt.Errorf("scan connection: %w", err)
		}
		connections = append(connections, connection)
	}
	return connections, rows.Err()
}

// NewConnection is an authorisation result on its way to storage.
//
// The tokens are plaintext here and nowhere else: SaveConnection seals them
// before they reach a statement, and this struct is not returned by anything.
type NewConnection struct {
	WorkspaceID         uuid.UUID
	Provider            string
	ConnectedByUserID   *uuid.UUID
	ExternalAccountID   string
	ExternalAccountName string
	AccessToken         string
	RefreshToken        string
	ExpiresAt           *time.Time
	Scopes              []string
	Metadata            map[string]any
}

// SaveConnection records a completed authorisation, replacing any live one.
//
// Reconnecting the same provider updates in place rather than inserting, which
// is what the partial unique index enforces anyway. Doing it as an upsert means
// a workspace that re-authorises after an expiry keeps its connection id, and
// so keeps its audit history attached to something that still exists.
func (repository *Repository) SaveConnection(
	ctx context.Context,
	incoming NewConnection,
	now time.Time,
) (core.Connection, error) {
	if incoming.WorkspaceID == uuid.Nil {
		return core.Connection{}, errors.New("integrations: workspace is required")
	}
	if strings.TrimSpace(incoming.Provider) == "" {
		return core.Connection{}, errors.New("integrations: provider is required")
	}

	sealedAccess, err := repository.seal(incoming.AccessToken)
	if err != nil {
		return core.Connection{}, fmt.Errorf("seal access token: %w", err)
	}
	sealedRefresh, err := repository.seal(incoming.RefreshToken)
	if err != nil {
		return core.Connection{}, fmt.Errorf("seal refresh token: %w", err)
	}
	metadata := incoming.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	scopes := incoming.Scopes
	if scopes == nil {
		scopes = []string{}
	}

	row := repository.Pool.QueryRow(
		ctx,
		`INSERT INTO integration_connections (
			workspace_id, provider, connected_by_user_id,
			external_account_id, external_account_name,
			access_token_encrypted, refresh_token_encrypted,
			expires_at, scopes, metadata,
			status, status_detail, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'connected',NULL,$11,$11)
		 ON CONFLICT (workspace_id, provider) WHERE status <> 'disconnected'
		 DO UPDATE SET
			connected_by_user_id   = EXCLUDED.connected_by_user_id,
			external_account_id    = EXCLUDED.external_account_id,
			external_account_name  = EXCLUDED.external_account_name,
			access_token_encrypted = EXCLUDED.access_token_encrypted,
			-- A provider that omits a refresh token on re-authorisation has not
			-- revoked the one we hold, so keep it rather than blanking it.
			refresh_token_encrypted = COALESCE(
				EXCLUDED.refresh_token_encrypted,
				integration_connections.refresh_token_encrypted),
			expires_at    = EXCLUDED.expires_at,
			scopes        = EXCLUDED.scopes,
			metadata      = EXCLUDED.metadata,
			status        = 'connected',
			status_detail = NULL,
			updated_at    = EXCLUDED.updated_at
		 RETURNING`+connectionColumns,
		incoming.WorkspaceID, incoming.Provider, incoming.ConnectedByUserID,
		nullIfEmpty(incoming.ExternalAccountID), nullIfEmpty(incoming.ExternalAccountName),
		sealedAccess, sealedRefresh,
		incoming.ExpiresAt, scopes, metadata, now.UTC(),
	)
	connection, err := scanConnection(row)
	if err != nil {
		return core.Connection{}, fmt.Errorf("save %s connection: %w", incoming.Provider, err)
	}
	return connection, nil
}

// Credential is a decrypted token, held only for the duration of a call.
type Credential struct {
	ConnectionID uuid.UUID
	AccessToken  string
	RefreshToken string
	ExpiresAt    *time.Time
}

// Credential opens the sealed tokens for a live connection.
//
// The only method in this package that decrypts. Callers should treat the
// result as short-lived: hand it to the runtime, then let it go out of scope.
func (repository *Repository) Credential(
	ctx context.Context,
	workspaceID uuid.UUID,
	provider string,
) (Credential, error) {
	var (
		credential    Credential
		sealedAccess  []byte
		sealedRefresh []byte
		status        string
	)
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT id, access_token_encrypted, refresh_token_encrypted, expires_at, status
		   FROM integration_connections
		  WHERE workspace_id = $1 AND provider = $2 AND status <> 'disconnected'`,
		workspaceID, provider,
	).Scan(&credential.ConnectionID, &sealedAccess, &sealedRefresh,
		&credential.ExpiresAt, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Credential{}, core.ErrNoConnection
	}
	if err != nil {
		return Credential{}, fmt.Errorf("load %s credential: %w", provider, err)
	}
	if len(sealedAccess) == 0 {
		return Credential{}, ErrNoCredential
	}

	access, err := repository.Sealer.Open(sealedAccess)
	if err != nil {
		return Credential{}, fmt.Errorf("open %s access token: %w", provider, err)
	}
	credential.AccessToken = string(access)
	if len(sealedRefresh) > 0 {
		refresh, err := repository.Sealer.Open(sealedRefresh)
		if err != nil {
			return Credential{}, fmt.Errorf("open %s refresh token: %w", provider, err)
		}
		credential.RefreshToken = string(refresh)
	}
	return credential, nil
}

// MarkConnectionStatus records that a connection needs attention.
//
// The detail is shown in settings, so callers must pass a human explanation and
// never a provider response body: those have been known to echo a token back.
func (repository *Repository) MarkConnectionStatus(
	ctx context.Context,
	connectionID uuid.UUID,
	status core.ConnectionStatus,
	detail string,
	now time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE integration_connections
		    SET status = $2, status_detail = $3, updated_at = $4
		  WHERE id = $1`,
		connectionID, string(status), nullIfEmpty(detail), now.UTC(),
	)
	if err != nil {
		return fmt.Errorf("mark connection status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Disconnect ends a connection and destroys its credentials.
//
// The row survives so audit entries still resolve, but the tokens do not: a
// disconnect that left a usable token behind would mean "revoked" in the UI and
// "still works" in the database.
func (repository *Repository) Disconnect(
	ctx context.Context,
	workspaceID uuid.UUID,
	provider string,
	now time.Time,
) error {
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE integration_connections
		    SET status = 'disconnected',
		        status_detail = NULL,
		        access_token_encrypted = NULL,
		        refresh_token_encrypted = NULL,
		        expires_at = NULL,
		        updated_at = $3
		  WHERE workspace_id = $1 AND provider = $2 AND status <> 'disconnected'`,
		workspaceID, provider, now.UTC(),
	)
	if err != nil {
		return fmt.Errorf("disconnect %s: %w", provider, err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (repository *Repository) seal(plaintext string) ([]byte, error) {
	if plaintext == "" {
		return nil, nil
	}
	return repository.Sealer.Seal([]byte(plaintext))
}

func nullIfEmpty(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
