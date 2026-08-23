package migrations

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestP2CatalogProjectMigrationIsAdditiveAndWorkspaceOwned(t *testing.T) {
	t.Parallel()
	migration := p2CatalogProjectMigration(t)
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS projects",
		"CREATE TABLE IF NOT EXISTS project_resources",
		"CREATE TABLE IF NOT EXISTS issue_project_links",
		"CREATE TABLE IF NOT EXISTS issue_labels",
		"CREATE TABLE IF NOT EXISTS issue_label_memberships",
		"CREATE TABLE IF NOT EXISTS issue_status_definitions",
		"CREATE TABLE IF NOT EXISTS issue_property_definitions",
		"CREATE TABLE IF NOT EXISTS issue_property_values",
		"CREATE TABLE IF NOT EXISTS quick_action_definitions",
		"berry_validate_owned_issue_row",
		"berry_keep_status_definition_identity",
		"berry_validate_property_value",
		"berry_seed_workspace_issue_statuses",
	} {
		if !strings.Contains(migration.SQL, required) {
			t.Errorf("P2 migration is missing %q", required)
		}
	}
	for _, destructive := range []string{"DROP TABLE", "DROP COLUMN", "TRUNCATE"} {
		if strings.Contains(strings.ToUpper(migration.SQL), destructive) {
			t.Errorf("P2 migration contains destructive statement %q", destructive)
		}
	}
	for _, legacy := range []string{"linear", "multica"} {
		if strings.Contains(strings.ToLower(migration.SQL), legacy) {
			t.Errorf("P2 migration contains legacy identifier %q", legacy)
		}
	}
}

func TestP2CatalogProjectMigrationBackfillsAndEnforcesIsolation(t *testing.T) {
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

	schema := "berry_p2_catalog_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
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
		t.Fatalf("List() error = %v", err)
	}
	for _, migration := range all {
		if migration.Version >= 5 {
			break
		}
		if _, err := pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("apply prerequisite %s: %v", migration.Name, err)
		}
	}
	userID, firstWorkspace, secondWorkspace := uuid.New(), uuid.New(), uuid.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO users (id, email, name, role)
		 VALUES ($1, $2, 'P2 Migration Owner', 'member')`,
		userID,
		fmt.Sprintf("%s@berry.test", userID),
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (id, name, slug, created_by)
		 VALUES ($1, 'Before P2', $2, $3)`,
		firstWorkspace,
		"before-"+firstWorkspace.String()[:8],
		userID,
	); err != nil {
		t.Fatalf("seed pre-migration workspace: %v", err)
	}
	if _, err := pool.Exec(ctx, p2CatalogProjectMigration(t).SQL); err != nil {
		t.Fatalf("apply P2 migration: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspaces (id, name, slug, created_by)
		 VALUES ($1, 'After P2', $2, $3)`,
		secondWorkspace,
		"after-"+secondWorkspace.String()[:8],
		userID,
	); err != nil {
		t.Fatalf("seed post-migration workspace: %v", err)
	}
	for _, workspaceID := range []uuid.UUID{firstWorkspace, secondWorkspace} {
		var count int
		if err := pool.QueryRow(
			ctx,
			`SELECT count(*) FROM issue_status_definitions WHERE workspace_id = $1`,
			workspaceID,
		).Scan(&count); err != nil {
			t.Fatalf("count seeded statuses: %v", err)
		}
		if count != 6 {
			t.Fatalf("workspace %s status count=%d, want 6", workspaceID, count)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`UPDATE issue_status_definitions
		    SET category = 'done'
		  WHERE workspace_id = $1 AND key = 'backlog'`,
		firstWorkspace,
	); err == nil {
		t.Fatal("database allowed immutable workflow category update")
	}

	if _, err := pool.Exec(
		ctx,
		`INSERT INTO workspace_memberships (workspace_id, user_id, role)
		 VALUES ($1, $3, 'owner'), ($2, $3, 'owner')`,
		firstWorkspace,
		secondWorkspace,
		userID,
	); err != nil {
		t.Fatalf("seed memberships: %v", err)
	}
	boardID, issueID, labelID := uuid.New(), uuid.New(), uuid.New()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
		    id, workspace_id, name, slug, columns, created_by
		 ) VALUES ($1, $2, 'P2 Board', $3, '[]'::jsonb, $4)`,
		boardID,
		firstWorkspace,
		"p2-"+boardID.String()[:8],
		userID,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issues (id, board_id, number, title, created_by)
		 VALUES ($1, $2, 1, 'P2 issue', $3)`,
		issueID,
		boardID,
		userID,
	); err != nil {
		t.Fatalf("seed issue: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issue_labels (id, workspace_id, name, color, created_by)
		 VALUES ($1, $2, 'Other workspace', '#112233', $3)`,
		labelID,
		secondWorkspace,
		userID,
	); err != nil {
		t.Fatalf("seed label: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issue_label_memberships (
		    workspace_id, issue_id, label_id, assigned_by
		 ) VALUES ($1, $2, $3, $4)`,
		secondWorkspace,
		issueID,
		labelID,
		userID,
	); err == nil {
		t.Fatal("database allowed a cross-workspace issue label membership")
	}
}

func p2CatalogProjectMigration(t *testing.T) Migration {
	t.Helper()
	all, err := List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	for _, migration := range all {
		if migration.Version == 5 &&
			migration.Name == "005_p2_catalogs_projects.up.sql" {
			return migration
		}
	}
	t.Fatal("P2 catalog/project migration is not embedded")
	return Migration{}
}
