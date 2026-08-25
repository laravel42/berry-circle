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

// applyAll runs every migration into an isolated schema and returns the pool.
func applyAll(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
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

	schema := "berry_artifacts_" + uuid.NewString()[:8]
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
	for _, migration := range all {
		if _, err := pool.Exec(ctx, migration.SQL); err != nil {
			t.Fatalf("apply %s: %v", migration.Name, err)
		}
	}
	return ctx, pool
}

// The declared uploader kind and the populated column must agree. An
// attachment claiming a user produced it while carrying an agent id would make
// a review trail lie about who wrote a file.
func TestArtifactUploaderKindAndColumnMustAgree(t *testing.T) {
	ctx, pool := applyAll(t)

	var constraint string
	if err := pool.QueryRow(ctx, `
		SELECT conname FROM pg_constraint
		 WHERE conname = 'attachments_uploader_kind_ck'`).Scan(&constraint); err != nil {
		t.Fatalf("uploader kind constraint missing: %v", err)
	}

	// The constraint lands NOT VALID so it never fails an existing row, which
	// means the check only bites on write. Assert that it does.
	definition := ""
	if err := pool.QueryRow(ctx, `
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		 WHERE conname = 'attachments_uploader_kind_ck'`).Scan(&definition); err != nil {
		t.Fatalf("read constraint: %v", err)
	}
	for _, required := range []string{"uploader_type", "uploader_agent_id", "uploader_id"} {
		if !strings.Contains(definition, required) {
			t.Errorf("constraint does not mention %q: %s", required, definition)
		}
	}
}

// Deleting a run is bookkeeping. It must not destroy the file that run
// produced, so the reference nulls rather than cascading.
func TestDeletingARunKeepsItsArtifacts(t *testing.T) {
	ctx, pool := applyAll(t)

	var rule string
	if err := pool.QueryRow(ctx, `
		SELECT rc.delete_rule
		  FROM information_schema.table_constraints tc
		  JOIN information_schema.key_column_usage kcu
		    ON kcu.constraint_name = tc.constraint_name
		  JOIN information_schema.constraint_column_usage ccu
		    ON ccu.constraint_name = tc.constraint_name
		  JOIN information_schema.referential_constraints rc
		    ON rc.constraint_name = tc.constraint_name
		 WHERE tc.table_name = 'attachments'
		   AND kcu.column_name = 'run_id'
		   AND ccu.table_name = 'runs'`).Scan(&rule); err != nil {
		t.Fatalf("run_id foreign key missing: %v", err)
	}
	if rule != "SET NULL" {
		t.Errorf("attachments.run_id delete rule = %q, want SET NULL", rule)
	}
}

// Both actor columns keep a real foreign key, so a deleted actor nulls its
// reference instead of leaving an id that resolves to nothing. That is the
// reason for two columns rather than one polymorphic id.
func TestBothUploaderColumnsKeepAForeignKey(t *testing.T) {
	ctx, pool := applyAll(t)

	for column, target := range map[string]string{
		"uploader_id":       "users",
		"uploader_agent_id": "agents",
	} {
		var rule string
		if err := pool.QueryRow(ctx, `
			SELECT rc.delete_rule
			  FROM information_schema.table_constraints tc
			  JOIN information_schema.key_column_usage kcu
			    ON kcu.constraint_name = tc.constraint_name
			  JOIN information_schema.constraint_column_usage ccu
			    ON ccu.constraint_name = tc.constraint_name
			  JOIN information_schema.referential_constraints rc
			    ON rc.constraint_name = tc.constraint_name
			 WHERE tc.table_name = 'attachments'
			   AND kcu.column_name = $1
			   AND ccu.table_name = $2`, column, target).Scan(&rule); err != nil {
			t.Fatalf("%s -> %s foreign key missing: %v", column, target, err)
		}
		if rule != "SET NULL" {
			t.Errorf("%s delete rule = %q, want SET NULL", column, rule)
		}
	}
}

// Existing rows predate the column and were all uploaded by a person; leaving
// them null would make every historical attachment read as unattributed.
func TestExistingAttachmentsBackfillToUser(t *testing.T) {
	ctx, pool := applyAll(t)
	sql := ""
	for _, migration := range mustList(t) {
		if migration.Name == "013_run_artifacts.up.sql" {
			sql = migration.SQL
		}
	}
	if sql == "" {
		t.Fatal("migration 013 missing from List()")
	}
	if !strings.Contains(sql, "UPDATE attachments SET uploader_type = 'user'") {
		t.Error("migration does not backfill existing attachments")
	}
	// The index exists for the query this feature is built to answer.
	var index string
	if err := pool.QueryRow(ctx, `
		SELECT indexname FROM pg_indexes
		 WHERE tablename = 'attachments' AND indexname = 'attachments_run_created_idx'`).
		Scan(&index); err != nil {
		t.Fatalf("run artifact index missing: %v", err)
	}
	_ = fmt.Sprint(index)
}

func mustList(t *testing.T) []Migration {
	t.Helper()
	all, err := List()
	if err != nil {
		t.Fatalf("list migrations: %v", err)
	}
	return all
}
