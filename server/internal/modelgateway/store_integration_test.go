package modelgateway

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The role table is global: one row per role, replaced on re-spawn, read
// back in provisioning order.
func TestPostgresStoreRoundTripsRoleAgents(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(pool.Close)
	store, err := NewStore(pool)
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	// Roles are global rows: every suite that rewrites them holds the same
	// advisory lock, and a snapshot leaves a shared database as found.
	lockConn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire lock connection: %v", err)
	}
	if _, err := lockConn.Exec(ctx, `SELECT pg_advisory_lock(hashtext('berry-test:model_role_agents'))`); err != nil {
		t.Fatalf("advisory lock: %v", err)
	}
	t.Cleanup(func() {
		_, _ = lockConn.Exec(context.Background(), `SELECT pg_advisory_unlock(hashtext('berry-test:model_role_agents'))`)
		lockConn.Release()
	})
	before, _ := store.List(ctx)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM model_role_agents`)
		for _, row := range before {
			_ = store.Upsert(context.Background(), row, time.Now())
		}
	})
	if _, err := pool.Exec(ctx, `DELETE FROM model_role_agents`); err != nil {
		t.Fatalf("clear: %v", err)
	}
	now := time.Date(2026, time.August, 25, 12, 0, 0, 0, time.UTC)
	maxTokens := int64(16384)
	first := RoleAgent{Role: RolePlanner, OpenFangAgentID: uuid.New(), UpstreamName: "berry-planner-" + uuid.NewString()[:8], Provider: "openrouter", Model: "m1", PromptVersion: "planner-v1", MaxTokens: &maxTokens, Status: StatusAvailable}
	if err := store.Upsert(ctx, first, now); err != nil {
		t.Fatalf("Upsert() error = %v", err)
	}
	got, err := store.Get(ctx, RolePlanner)
	if err != nil || got.OpenFangAgentID != first.OpenFangAgentID || got.UpstreamName != first.UpstreamName || got.MaxTokens == nil || *got.MaxTokens != 16384 || got.Status != StatusAvailable {
		t.Fatalf("Get() = %+v, %v", got, err)
	}
	if _, err := store.Get(ctx, RoleCritic); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get(critic) = %v, want ErrNotFound", err)
	}
	replaced := first
	replaced.OpenFangAgentID = uuid.New()
	replaced.UpstreamName = "berry-planner-" + uuid.NewString()[:8]
	replaced.Model = "m2"
	if err := store.Upsert(ctx, replaced, now.Add(time.Minute)); err != nil {
		t.Fatalf("re-spawn Upsert() error = %v", err)
	}
	if err := store.SetStatus(ctx, RolePlanner, StatusOffline, now.Add(2*time.Minute)); err != nil {
		t.Fatalf("SetStatus() error = %v", err)
	}
	if err := store.SetStatus(ctx, RoleCritic, StatusOffline, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetStatus(critic) = %v", err)
	}
	if err := store.Upsert(ctx, RoleAgent{Role: RoleClassifier, OpenFangAgentID: uuid.New(), UpstreamName: "berry-classifier-" + uuid.NewString()[:8], Provider: "p", Model: "m", PromptVersion: "intent-v1", Status: StatusAvailable}, now); err != nil {
		t.Fatalf("Upsert(classifier) error = %v", err)
	}
	rows, err := store.List(ctx)
	if err != nil || len(rows) != 2 || rows[0].Role != RoleClassifier || rows[1].Role != RolePlanner || rows[1].Model != "m2" || rows[1].Status != StatusOffline {
		t.Fatalf("List() = %+v, %v", rows, err)
	}
	if err := store.Upsert(ctx, RoleAgent{Role: Role("oracle"), OpenFangAgentID: uuid.New(), UpstreamName: "x", Provider: "p", Model: "m", PromptVersion: "v"}, now); err == nil {
		t.Fatal("unknown role accepted")
	}
}
