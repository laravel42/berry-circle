package integrations

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/oauth"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/secrets"
)

func testRepository(t *testing.T) (*Repository, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("INTEGRATIONS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("INTEGRATIONS_TEST_DATABASE_URL not set")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	key, err := secrets.GenerateKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	sealer, err := secrets.NewFromBase64Key(key)
	if err != nil {
		t.Fatalf("sealer: %v", err)
	}
	repository, err := New(pool, sealer)
	if err != nil {
		t.Fatalf("new repository: %v", err)
	}
	return repository, pool
}

// fixture creates a workspace, a user and an agent to hang grants off.
func fixture(t *testing.T, pool *pgxpool.Pool) (ws, user, agent uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	user, ws, agent = uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("fixture %q: %v", sql[:40], err)
		}
	}
	exec(`INSERT INTO users (id,email,name,role) VALUES ($1,$2,'T','admin')`,
		user, user.String()+"@berry.test")
	exec(`INSERT INTO workspaces (id,name,slug,created_by) VALUES ($1,'W',$2,$3)`,
		ws, "w"+ws.String()[:8], user)
	exec(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'admin')`, ws, user)
	exec(`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status)
	      VALUES ($1,$2,gen_random_uuid(),'Bot','available')`, agent, ws)
	return ws, user, agent
}

func TestSaveConnectionSealsTokensAtRest(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, _ := fixture(t, pool)
	now := time.Now().UTC()

	const plaintext = "ghp_supersecret_value_0123456789"
	connection, err := repository.SaveConnection(ctx, NewConnection{
		WorkspaceID:         ws,
		Provider:            "github",
		ConnectedByUserID:   &user,
		ExternalAccountName: "acme",
		AccessToken:         plaintext,
		RefreshToken:        "refresh_0123456789",
		Scopes:              []string{"repo"},
	}, now)
	if err != nil {
		t.Fatalf("SaveConnection: %v", err)
	}
	if connection.Status != core.StatusConnected {
		t.Errorf("status = %q, want connected", connection.Status)
	}

	// The bytes on disk must not contain the token. This is the guarantee the
	// bytea column exists to make, so it is asserted against the raw column
	// rather than through any accessor that could be doing the right thing for
	// the wrong reason.
	var stored []byte
	if err := pool.QueryRow(ctx,
		`SELECT access_token_encrypted FROM integration_connections WHERE id = $1`,
		connection.ID).Scan(&stored); err != nil {
		t.Fatalf("read column: %v", err)
	}
	if bytes.Contains(stored, []byte(plaintext)) {
		t.Fatal("access token is readable in the database")
	}
	if len(stored) == 0 {
		t.Fatal("access token was not stored at all")
	}

	credential, err := repository.Credential(ctx, ws, "github")
	if err != nil {
		t.Fatalf("Credential: %v", err)
	}
	if credential.AccessToken != plaintext {
		t.Errorf("access token round-trip = %q", credential.AccessToken)
	}
	if credential.RefreshToken != "refresh_0123456789" {
		t.Errorf("refresh token round-trip = %q", credential.RefreshToken)
	}
}

func TestSaveConnectionReconnectKeepsIDAndRefreshToken(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, _ := fixture(t, pool)
	now := time.Now().UTC()

	first, err := repository.SaveConnection(ctx, NewConnection{
		WorkspaceID: ws, Provider: "slack", ConnectedByUserID: &user,
		AccessToken: "xoxb-first", RefreshToken: "keep-me",
	}, now)
	if err != nil {
		t.Fatalf("first save: %v", err)
	}

	// A re-authorisation that returns no refresh token must not erase the one
	// already held, or the connection silently becomes unrenewable.
	second, err := repository.SaveConnection(ctx, NewConnection{
		WorkspaceID: ws, Provider: "slack", ConnectedByUserID: &user,
		AccessToken: "xoxb-second",
	}, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("second save: %v", err)
	}
	if second.ID != first.ID {
		t.Errorf("reconnect changed id: %s -> %s", first.ID, second.ID)
	}

	credential, err := repository.Credential(ctx, ws, "slack")
	if err != nil {
		t.Fatalf("Credential: %v", err)
	}
	if credential.AccessToken != "xoxb-second" {
		t.Errorf("access token = %q, want the new one", credential.AccessToken)
	}
	if credential.RefreshToken != "keep-me" {
		t.Errorf("refresh token = %q, want the retained one", credential.RefreshToken)
	}
}

func TestDisconnectDestroysCredentials(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, _ := fixture(t, pool)
	now := time.Now().UTC()

	if _, err := repository.SaveConnection(ctx, NewConnection{
		WorkspaceID: ws, Provider: "notion", ConnectedByUserID: &user,
		AccessToken: "secret_notion_token",
	}, now); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := repository.Disconnect(ctx, ws, "notion", now); err != nil {
		t.Fatalf("Disconnect: %v", err)
	}

	if _, err := repository.Connection(ctx, ws, "notion"); !errors.Is(err, core.ErrNoConnection) {
		t.Errorf("Connection after disconnect = %v, want ErrNoConnection", err)
	}
	if _, err := repository.Credential(ctx, ws, "notion"); !errors.Is(err, core.ErrNoConnection) {
		t.Errorf("Credential after disconnect = %v, want ErrNoConnection", err)
	}

	// The row is kept for audit provenance, but nothing usable is left on it.
	var sealed []byte
	if err := pool.QueryRow(ctx,
		`SELECT access_token_encrypted FROM integration_connections
		  WHERE workspace_id = $1 AND provider = 'notion'`, ws).Scan(&sealed); err != nil {
		t.Fatalf("read column: %v", err)
	}
	if len(sealed) != 0 {
		t.Error("disconnect left a credential behind")
	}
}

func TestConsumeStateRedeemsExactlyOnce(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, _ := fixture(t, pool)
	now := time.Now().UTC()

	secret, err := oauth.NewSecret()
	if err != nil {
		t.Fatalf("NewSecret: %v", err)
	}
	if _, err := repository.CreateState(ctx, ws, user,
		"linear", "https://berry.test/callback", secret, "verifier-abc",
		[]string{"read"}, now); err != nil {
		t.Fatalf("CreateState: %v", err)
	}

	pending, err := repository.ConsumeState(ctx, secret, now.Add(time.Second))
	if err != nil {
		t.Fatalf("first ConsumeState: %v", err)
	}
	if pending.WorkspaceID != ws || pending.Provider != "linear" {
		t.Errorf("unexpected state: %+v", pending.State)
	}
	if pending.CodeVerifier != "verifier-abc" {
		t.Errorf("code verifier = %q", pending.CodeVerifier)
	}

	// A replayed callback must be refused.
	if _, err := repository.ConsumeState(ctx, secret, now.Add(2*time.Second)); !errors.Is(err, oauth.ErrStateUsed) {
		t.Errorf("replay = %v, want ErrStateUsed", err)
	}

	// And the verifier must not be readable in the clear.
	var sealed []byte
	if err := pool.QueryRow(ctx,
		`SELECT code_verifier_encrypted FROM integration_oauth_states WHERE id = $1`,
		pending.ID).Scan(&sealed); err != nil {
		t.Fatalf("read column: %v", err)
	}
	if bytes.Contains(sealed, []byte("verifier-abc")) {
		t.Error("code verifier is readable in the database")
	}
}

func TestConsumeStateRejectsUnknownAndExpired(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, _ := fixture(t, pool)
	now := time.Now().UTC()

	if _, err := repository.ConsumeState(ctx, "never-issued", now); !errors.Is(err, oauth.ErrStateUnknown) {
		t.Errorf("unknown = %v, want ErrStateUnknown", err)
	}

	secret, err := oauth.NewSecret()
	if err != nil {
		t.Fatalf("NewSecret: %v", err)
	}
	if _, err := repository.CreateState(ctx, ws, user,
		"gmail", "https://berry.test/callback", secret, "",
		nil, now); err != nil {
		t.Fatalf("CreateState: %v", err)
	}
	late := now.Add(oauth.StateTTL + time.Minute)
	if _, err := repository.ConsumeState(ctx, secret, late); !errors.Is(err, oauth.ErrStateExpired) {
		t.Errorf("expired = %v, want ErrStateExpired", err)
	}
}

func TestGrantsForExcludesAnotherAgentsGrant(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, _, agent := fixture(t, pool)
	other := uuid.New()
	if _, err := pool.Exec(ctx,
		`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status)
		 VALUES ($1,$2,gen_random_uuid(),'Other','available')`, other, ws); err != nil {
		t.Fatalf("second agent: %v", err)
	}
	now := time.Now().UTC()

	mustGrant := func(agentID *uuid.UUID, tool string, effect core.Effect) {
		t.Helper()
		if err := repository.SetGrant(ctx, core.Grant{
			WorkspaceID: ws, AgentID: agentID, Provider: "github",
			Tool: tool, MaxEffect: effect,
		}, now); err != nil {
			t.Fatalf("SetGrant %s: %v", tool, err)
		}
	}
	mustGrant(nil, "github.list_issues", core.EffectRead)
	mustGrant(&agent, "github.create_issue", core.EffectWrite)
	mustGrant(&other, "github.delete_repository", core.EffectDestructive)

	grants, err := repository.GrantsFor(ctx, ws, &agent, "github")
	if err != nil {
		t.Fatalf("GrantsFor: %v", err)
	}
	seen := map[string]bool{}
	for _, grant := range grants {
		seen[grant.Tool] = true
	}
	if !seen["github.list_issues"] {
		t.Error("workspace-wide grant did not apply to the agent")
	}
	if !seen["github.create_issue"] {
		t.Error("the agent's own grant is missing")
	}
	if seen["github.delete_repository"] {
		t.Error("another agent's grant leaked into this agent's set")
	}
}

func TestSetGrantIsIdempotentForWorkspaceWideRows(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, _, _ := fixture(t, pool)
	now := time.Now().UTC()

	grant := core.Grant{
		WorkspaceID: ws, Provider: "slack",
		Tool: "slack.post_message", MaxEffect: core.EffectRead,
	}
	for range 3 {
		if err := repository.SetGrant(ctx, grant, now); err != nil {
			t.Fatalf("SetGrant: %v", err)
		}
	}
	grant.MaxEffect = core.EffectExternalSideEffect
	if err := repository.SetGrant(ctx, grant, now); err != nil {
		t.Fatalf("SetGrant raise: %v", err)
	}

	var count int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM integration_permissions
		  WHERE workspace_id = $1 AND agent_id IS NULL AND tool = 'slack.post_message'`,
		ws).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("workspace-wide grant stored %d times, want 1", count)
	}

	grants, err := repository.GrantsFor(ctx, ws, nil, "slack")
	if err != nil {
		t.Fatalf("GrantsFor: %v", err)
	}
	if len(grants) != 1 || grants[0].MaxEffect != core.EffectExternalSideEffect {
		t.Fatalf("grants = %+v, want one raised to external_side_effect", grants)
	}

	if err := repository.RevokeGrant(ctx, ws, nil, "slack", "slack.post_message"); err != nil {
		t.Fatalf("RevokeGrant: %v", err)
	}
	grants, err = repository.GrantsFor(ctx, ws, nil, "slack")
	if err != nil {
		t.Fatalf("GrantsFor after revoke: %v", err)
	}
	if len(grants) != 0 {
		t.Fatalf("revoke left %d grants", len(grants))
	}
}

func TestApplyDefaultGrantsNeverArmsDestructiveTools(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, _, _ := fixture(t, pool)
	now := time.Now().UTC()

	for _, provider := range providers.All() {
		if _, err := repository.ApplyDefaultGrants(ctx, ws, provider, now); err != nil {
			t.Fatalf("ApplyDefaultGrants %s: %v", provider.ID(), err)
		}
	}

	granted, err := repository.ListGrants(ctx, ws)
	if err != nil {
		t.Fatalf("ListGrants: %v", err)
	}
	if len(granted) == 0 {
		t.Fatal("no default grants were applied at all")
	}
	for _, grant := range granted {
		if grant.MaxEffect == core.EffectDestructive {
			t.Errorf("%s was granted at destructive effect by default", grant.Tool)
		}
	}
}

func TestAuditRecordsAttemptBeforeOutcome(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, agent := fixture(t, pool)
	now := time.Now().UTC()

	auditID, err := repository.BeginAudit(ctx, AuditEntry{
		WorkspaceID: ws, AgentID: &agent, UserID: &user,
		Provider: "github", Tool: "github.create_issue",
		Effect: core.EffectWrite, InputSummary: "repo=acme/berry",
	}, now)
	if err != nil {
		t.Fatalf("BeginAudit: %v", err)
	}

	// Before completion the row exists and is visibly unfinished.
	var status string
	var completedAt *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT status, completed_at FROM integration_audit_events WHERE id = $1`,
		auditID).Scan(&status, &completedAt); err != nil {
		t.Fatalf("read started row: %v", err)
	}
	if status != AuditStarted || completedAt != nil {
		t.Fatalf("started row = %q/%v, want started and open", status, completedAt)
	}

	if err := repository.CompleteAudit(ctx, auditID, AuditResult{
		Status: AuditSucceeded, ResultSummary: "created #12",
		ExternalIDs: []string{"12"}, ExternalURL: "https://github.test/acme/berry/issues/12",
	}, now.Add(1500*time.Millisecond)); err != nil {
		t.Fatalf("CompleteAudit: %v", err)
	}

	records, err := repository.ListAudit(ctx, ws, 10)
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("ListAudit returned %d records, want 1", len(records))
	}
	record := records[0]
	if record.Status != AuditSucceeded {
		t.Errorf("status = %q", record.Status)
	}
	if record.CompletedAt == nil || record.DurationMS == nil {
		t.Fatal("completion columns must be written together")
	}
	if *record.DurationMS != 1500 {
		t.Errorf("duration = %d ms, want 1500", *record.DurationMS)
	}
}

func TestTruncateBoundsSummariesWithoutSplittingRunes(t *testing.T) {
	t.Parallel()
	long := ""
	for range summaryLimit + 100 {
		long += "é"
	}
	got := truncate(long)
	if len([]rune(got)) != summaryLimit+1 {
		t.Fatalf("truncated to %d runes, want %d plus ellipsis", len([]rune(got)), summaryLimit)
	}
	for _, r := range got {
		if r == '�' {
			t.Fatal("truncation split a multi-byte rune")
		}
	}
}

// TestAuthorizerDeniesByDefaultAgainstRealStorage wires the real repository
// into the authorizer, because the interfaces are only worth anything if the
// stored rows actually drive the decision. Every refusal below is a path that
// unit tests with a fake store would also pass — the point is that they pass
// with Postgres semantics too: NULL agent ids, partial indexes, array columns.
func TestAuthorizerDeniesByDefaultAgainstRealStorage(t *testing.T) {
	repository, pool := testRepository(t)
	ctx := context.Background()
	ws, user, agent := fixture(t, pool)
	now := time.Now().UTC()

	authorizer := core.PermissionAuthorizer{Grants: repository, Connections: repository}
	exec := core.ExecutionContext{WorkspaceID: ws, AgentID: &agent}

	readTool := core.Tool{
		Name: "github.list_issues", Provider: "github", Effect: core.EffectRead,
	}
	writeTool := core.Tool{
		Name: "github.create_issue", Provider: "github", Effect: core.EffectWrite,
	}

	// 1. No connection at all: refused before any grant is considered.
	decision, err := authorizer.Authorize(ctx, exec, readTool)
	if err != nil {
		t.Fatalf("Authorize unconnected: %v", err)
	}
	if decision.Allowed {
		t.Fatal("allowed a call with no connection")
	}

	if _, err := repository.SaveConnection(ctx, NewConnection{
		WorkspaceID: ws, Provider: "github", ConnectedByUserID: &user,
		AccessToken: "ghp_token",
	}, now); err != nil {
		t.Fatalf("save connection: %v", err)
	}

	// 2. Connected but ungranted: still refused. Connecting an account must not
	// by itself hand agents its tools.
	decision, err = authorizer.Authorize(ctx, exec, readTool)
	if err != nil {
		t.Fatalf("Authorize ungranted: %v", err)
	}
	if decision.Allowed {
		t.Fatal("connecting a provider granted tools on its own")
	}

	// 3. A read grant permits the read and refuses the write above it.
	if err := repository.SetGrant(ctx, core.Grant{
		WorkspaceID: ws, AgentID: &agent, Provider: "github",
		Tool: core.Wildcard, MaxEffect: core.EffectRead,
	}, now); err != nil {
		t.Fatalf("SetGrant: %v", err)
	}
	decision, err = authorizer.Authorize(ctx, exec, readTool)
	if err != nil {
		t.Fatalf("Authorize granted read: %v", err)
	}
	if !decision.Allowed {
		t.Fatalf("read refused under a read grant: %s", decision.Reason)
	}
	decision, err = authorizer.Authorize(ctx, exec, writeTool)
	if err != nil {
		t.Fatalf("Authorize write: %v", err)
	}
	if decision.Allowed {
		t.Fatal("a read grant executed a write")
	}

	// 4. An expired connection stops everything, grant or no grant.
	connection, err := repository.Connection(ctx, ws, "github")
	if err != nil {
		t.Fatalf("Connection: %v", err)
	}
	if err := repository.MarkConnectionStatus(
		ctx, connection.ID, core.StatusExpired, "token expired", now,
	); err != nil {
		t.Fatalf("MarkConnectionStatus: %v", err)
	}
	decision, err = authorizer.Authorize(ctx, exec, readTool)
	if err != nil {
		t.Fatalf("Authorize expired: %v", err)
	}
	if decision.Allowed {
		t.Fatal("an expired connection still authorised a call")
	}
}
