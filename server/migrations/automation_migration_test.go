package migrations

import (
	"strings"
	"testing"
)

// The planning and automation migrations are additive by design: they add
// tables, columns, triggers and named checks, and never drop or truncate data.
// Each one must also carry the objects the Go repositories are written against,
// so a renamed table cannot slip through as a green migration and a red server.
func TestPlanningAndAutomationMigrationsAreAdditiveAndComplete(t *testing.T) {
	t.Parallel()
	required := map[string][]string{
		"019_outbox_scope.up.sql": {
			"ADD COLUMN IF NOT EXISTS board_id",
			"outbox_events_board_replay_idx",
			"outbox_events_trigger_dispatch_order_idx",
		},
		"020_goals_plans_approvals.up.sql": {
			"CREATE TABLE IF NOT EXISTS goals",
			"CREATE TABLE IF NOT EXISTS goal_issues",
			"CREATE TABLE IF NOT EXISTS plan_versions",
			"CREATE TABLE IF NOT EXISTS planner_events",
			"CREATE TABLE IF NOT EXISTS approvals",
			"berry_block_unapproved_issue_start",
			"CREATE TABLE IF NOT EXISTS issue_dependencies",
			"berry_validate_issue_dependency",
			"CREATE TABLE IF NOT EXISTS automation_issue_origins",
			"plans_scope_ck",
			"plans_one_open_per_goal_key",
			"ALTER TABLE plans ALTER COLUMN project_id DROP NOT NULL",
		},
		"021_automations.up.sql": {
			"CREATE TABLE IF NOT EXISTS automations",
			"CREATE TABLE IF NOT EXISTS automation_versions",
			"CREATE TABLE IF NOT EXISTS automation_runs",
			"CREATE TABLE IF NOT EXISTS automation_step_runs",
			"CREATE TABLE IF NOT EXISTS automation_run_events",
			"berry_allocate_automation_run_event_sequence",
			"CREATE TABLE IF NOT EXISTS automation_trigger_receipts",
			"CREATE TABLE IF NOT EXISTS integration_webhook_deliveries",
			"automation_runs_source_event_key",
			"approvals_automation_fk",
		},
		"022_integrations_tools_inbox.up.sql": {
			"inbox_items_category_ck",
			"'approvals','goals','workflows'",
			"CREATE TABLE IF NOT EXISTS model_role_agents",
			"ADD COLUMN IF NOT EXISTS skills",
			"ADD COLUMN IF NOT EXISTS manifest_limits",
			"integration_connections_provider_ck",
			"ADD COLUMN IF NOT EXISTS automation_step_run_id",
		},
		"023_trigger_receipt_reason.up.sql": {
			"ALTER TABLE automation_trigger_receipts ADD COLUMN IF NOT EXISTS reason",
			"automation_trigger_receipts_reason_ck",
		},
		"025_extended_nodes_and_triggers.up.sql": {
			`(\[[0-9]{1,3}\])?$`,
			"ADD COLUMN IF NOT EXISTS parent_run_id",
			"ADD COLUMN IF NOT EXISTS parent_step_run_id",
			"ADD COLUMN IF NOT EXISTS depth",
			"automation_runs_depth_ck",
			"'workflow.run.succeeded', 'workflow.run.failed', 'workflow.run.cancelled'",
			"automations_active_integration_idx",
			"CREATE TABLE IF NOT EXISTS agent_asks",
		},
	}
	all, err := List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	found := make(map[string]Migration, len(all))
	for _, migration := range all {
		found[migration.Name] = migration
	}
	for name, substrings := range required {
		migration, ok := found[name]
		if !ok {
			t.Errorf("migration %s is not embedded", name)
			continue
		}
		for _, substring := range substrings {
			if !strings.Contains(migration.SQL, substring) {
				t.Errorf("%s is missing %q", name, substring)
			}
		}
		upper := strings.ToUpper(migration.SQL)
		for _, destructive := range []string{"DROP TABLE", "DROP COLUMN", "TRUNCATE"} {
			if strings.Contains(upper, destructive) {
				t.Errorf("%s contains destructive statement %q", name, destructive)
			}
		}
	}
}
