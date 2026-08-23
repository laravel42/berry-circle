package p2

import (
	"strings"
	"testing"

	"github.com/laravel42/berry-circle/server/migrations"
)

func TestP2MigrationDependsOnlyOnCoreWorkspaceSchema(t *testing.T) {
	t.Parallel()
	all, err := migrations.List()
	if err != nil {
		t.Fatalf("migrations.List() error = %v", err)
	}
	var sql string
	for _, migration := range all {
		if migration.Name == "007_p2_views_inbox.up.sql" {
			sql = migration.SQL
			break
		}
	}
	if sql == "" {
		t.Fatal("007_p2_views_inbox.up.sql is not embedded")
	}
	for _, required := range []string{
		"CREATE TABLE IF NOT EXISTS saved_issue_views",
		"CREATE TABLE IF NOT EXISTS issue_view_preferences",
		"CREATE TABLE IF NOT EXISTS user_pins",
		"CREATE TABLE IF NOT EXISTS notification_preferences",
		"CREATE TABLE IF NOT EXISTS inbox_items",
		"CREATE TABLE IF NOT EXISTS inbox_projection_events",
		"UNIQUE (workspace_id, user_id, position) DEFERRABLE",
		"WHERE read_at IS NULL AND archived_at IS NULL",
		"REFERENCES outbox_events(id)",
		"outbox_events_inbox_projection_order_idx",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("P2 migration is missing %q", required)
		}
	}
	for _, forbidden := range []string{
		"REFERENCES projects",
		"project_members",
		"005_",
		"006_",
	} {
		if strings.Contains(strings.ToLower(sql), strings.ToLower(forbidden)) {
			t.Errorf("P2 migration has forbidden dependency %q", forbidden)
		}
	}
}
