package migrations

import (
	"strings"
	"testing"
)

func TestP2CollaborationMigrationIsBoundedAndIndependentOfMigrationFive(t *testing.T) {
	t.Parallel()
	all, err := List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	var sql string
	for _, migration := range all {
		if migration.Name == "006_p2_collaboration.up.sql" {
			sql = migration.SQL
			break
		}
	}
	if sql == "" {
		t.Fatal("006_p2_collaboration.up.sql was not embedded")
	}
	for _, required := range []string{
		"ADD COLUMN IF NOT EXISTS revision",
		"comments_one_resolution_per_thread_key",
		"CREATE TABLE IF NOT EXISTS attachments",
		"attachments_comment_issue_fk",
		"attachments_storage_key_shape_ck",
		"CREATE TABLE IF NOT EXISTS issue_reactions",
		"CREATE TABLE IF NOT EXISTS comment_reactions",
		"CREATE TABLE IF NOT EXISTS issue_subscribers",
		"issue_subscribers_membership_fk",
		"berry_p2_enforce_subscriber_issue_workspace",
		"ON CONFLICT (issue_id, user_id) DO NOTHING",
	} {
		if !strings.Contains(sql, required) {
			t.Errorf("collaboration migration is missing %q", required)
		}
	}
	for _, migrationFiveObject := range []string{
		"projects",
		"project_resources",
		"issue_project_links",
		"issue_labels",
		"catalogs",
	} {
		if strings.Contains(strings.ToLower(sql), migrationFiveObject) {
			t.Errorf(
				"collaboration migration unexpectedly depends on migration 005 object %q",
				migrationFiveObject,
			)
		}
	}
}
