package migrations

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIdentityMigrationBackfillsExistingUsersAndBoards(t *testing.T) {
	databaseURL := os.Getenv("BERRY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("BERRY_TEST_DATABASE_URL is not configured")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open BERRY_TEST_DATABASE_URL: %v", err)
	}
	t.Cleanup(admin.Close)
	if err := admin.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}

	schema := "berry_identity_" + uuid.NewString()[:8]
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create isolated schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
	})
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse BERRY_TEST_DATABASE_URL: %v", err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatalf("open isolated pool: %v", err)
	}
	t.Cleanup(pool.Close)

	all, err := List()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	for _, migration := range all[:4] {
		if _, err := pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("apply prerequisite %s: %v", migration.Name, err)
		}
	}
	userID := uuid.New()
	boardID := uuid.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO users (id, email, name, role)
		 VALUES ($1, $2, 'Existing Berry User', 'member')`,
		userID,
		fmt.Sprintf("%s@berry.test", userID),
	); err != nil {
		t.Fatalf("seed existing user: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (id, name, slug, columns, created_by)
		 VALUES ($1, 'Existing Board', $2, '[]'::jsonb, $3)`,
		boardID,
		"ex-"+boardID.String()[:8],
		userID,
	); err != nil {
		t.Fatalf("seed existing board: %v", err)
	}

	if _, err := pool.Exec(ctx, all[4].SQL); err != nil {
		t.Fatalf("apply %s: %v", all[4].Name, err)
	}
	newBoardID := uuid.New()
	var newBoardWorkspace uuid.UUID
	if err := pool.QueryRow(
		ctx,
		`INSERT INTO boards (id, name, slug, columns, created_by)
		 VALUES ($1, 'Post Migration Board', $2, '[]'::jsonb, $3)
		 RETURNING workspace_id`,
		newBoardID,
		"po-"+newBoardID.String()[:8],
		userID,
	).Scan(&newBoardWorkspace); err != nil {
		t.Fatalf("create board through compatibility trigger: %v", err)
	}
	var (
		workspaceID     uuid.UUID
		currentID       uuid.UUID
		boardWorkspace  uuid.UUID
		membershipRole  string
		userCount       int
		preservedBoards int
	)
	if err := pool.QueryRow(
		ctx,
		`SELECT last_workspace_id FROM users WHERE id = $1`,
		userID,
	).Scan(&currentID); err != nil {
		t.Fatalf("read current workspace: %v", err)
	}
	if err := pool.QueryRow(
		ctx,
		`SELECT workspace_id FROM boards WHERE id = $1`,
		boardID,
	).Scan(&boardWorkspace); err != nil {
		t.Fatalf("read board workspace: %v", err)
	}
	if err := pool.QueryRow(
		ctx,
		`SELECT workspace_id, role::text
		   FROM workspace_memberships
		  WHERE user_id = $1`,
		userID,
	).Scan(&workspaceID, &membershipRole); err != nil {
		t.Fatalf("read backfilled membership: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&userCount); err != nil {
		t.Fatalf("count users: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM boards`).Scan(&preservedBoards); err != nil {
		t.Fatalf("count boards: %v", err)
	}
	if workspaceID != currentID || workspaceID != boardWorkspace {
		t.Fatalf(
			"workspace mismatch membership=%s current=%s board=%s",
			workspaceID,
			currentID,
			boardWorkspace,
		)
	}
	if newBoardWorkspace != workspaceID {
		t.Fatalf(
			"new board workspace=%s, want %s",
			newBoardWorkspace,
			workspaceID,
		)
	}
	if membershipRole != "owner" {
		t.Fatalf("backfilled role=%q, want owner", membershipRole)
	}
	if userCount != 1 || preservedBoards != 2 {
		t.Fatalf("backfill lost rows: users=%d boards=%d", userCount, preservedBoards)
	}
}
