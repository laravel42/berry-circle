package agents

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func archivePool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("AGENTS_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("AGENTS_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

// Removing an agent has to outlast the next reconcile.
//
// The runtime keeps listing an agent somebody removed from Berry — that is the
// whole point of removing it here rather than there — so a sync that cleared
// archived_at made a duplicate agent impossible to get rid of: it came back
// within the minute, every time.
func TestSyncDoesNotResurrectAnArchivedAgent(t *testing.T) {
	ctx, pool := archivePool(t)
	user, workspace := uuid.New(), uuid.New()
	agent, upstream := uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id,email,name,role) VALUES ($1,$2,'T','admin')`,
		user, user.String()+"@berry.test")
	exec(`INSERT INTO workspaces (id,name,slug,created_by) VALUES ($1,'W',$2,$3)`,
		workspace, "w"+workspace.String()[:8], user)
	exec(`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status,archived_at)
	      VALUES ($1,$2,$3,'duplicate','available',now())`, agent, workspace, upstream)
	t.Cleanup(func() {
		pool.Exec(ctx, `DELETE FROM agents WHERE id = $1`, agent)
		pool.Exec(ctx, `DELETE FROM workspaces WHERE id = $1`, workspace)
		pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user)
	})

	now := time.Now().UTC()
	store := PostgresStore{Pool: pool}
	if err := store.SyncSummaries(ctx, workspace, []SummaryUpdate{{
		ID:              uuid.New(),
		WorkspaceID:     workspace,
		OpenFangAgentID: upstream,
		Name:            "duplicate",
		Status:          "available",
		CreatedAt:       now,
	}}, now); err != nil {
		t.Fatalf("SyncSummaries: %v", err)
	}

	var archived *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT archived_at FROM agents WHERE id = $1`, agent).Scan(&archived); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if archived == nil {
		t.Fatal("the sync un-archived an agent somebody removed")
	}

	// And the row is still reconciled — archived is not the same as ignored.
	var synced *time.Time
	if err := pool.QueryRow(ctx,
		`SELECT last_synced_at FROM agents WHERE id = $1`, agent).Scan(&synced); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if synced == nil {
		t.Error("an archived agent was skipped by the sync entirely")
	}
}
