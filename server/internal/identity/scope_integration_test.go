package identity

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A goal, plan, approval, workflow or run in another workspace must look
// exactly like one that does not exist, and an archived goal must vanish the
// same way a deleted issue does.
func TestPlanningScopesHideOtherWorkspacesAndArchivedGoals(t *testing.T) {
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
	now := time.Date(2026, time.August, 25, 13, 0, 0, 0, time.UTC)
	memberID, outsiderID := uuid.New(), uuid.New()
	workspaceID := uuid.New()
	goalID, archivedGoalID, planID, approvalID, automationID, runID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = ANY($1::uuid[])`, []uuid.UUID{memberID, outsiderID})
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	for _, userID := range []uuid.UUID{memberID, outsiderID} {
		exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Scope', 'member', $3, $3)`,
			userID, fmt.Sprintf("%s@berry.test", userID), now)
	}
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Scope', $2, $3, $4, $4)`,
		workspaceID, "scope-"+workspaceID.String()[:8], memberID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'member', $3, $3)`,
		workspaceID, memberID, now)
	exec(`INSERT INTO goals (id, workspace_id, title) VALUES ($1, $2, 'Live')`, goalID, workspaceID)
	exec(`INSERT INTO goals (id, workspace_id, title, deleted_at) VALUES ($1, $2, 'Gone', now())`, archivedGoalID, workspaceID)
	exec(`INSERT INTO plans (id, workspace_id, goal_id, source, status) VALUES ($1, $2, $3, 'ai', 'draft')`, planID, workspaceID, goalID)
	exec(`INSERT INTO approvals (id, workspace_id, kind, title, goal_id, requested_from_role) VALUES ($1, $2, 'plan', 'Start', $3, 'member')`,
		approvalID, workspaceID, goalID)
	exec(`INSERT INTO automations (id, workspace_id, name, definition, trigger_type) VALUES ($1, $2, 'Flow', '{"version":"1"}'::jsonb, 'manual')`,
		automationID, workspaceID)
	exec(`INSERT INTO automation_runs (id, workspace_id, automation_id, automation_version, trigger_type) VALUES ($1, $2, $3, 1, 'manual')`,
		runID, workspaceID, automationID)

	repository, err := NewRepository(pool)
	if err != nil {
		t.Fatalf("NewRepository() error = %v", err)
	}
	resolvers := map[string]func(uuid.UUID) (Scope, error){
		"goal":       func(user uuid.UUID) (Scope, error) { return repository.GoalScope(ctx, user, goalID) },
		"plan":       func(user uuid.UUID) (Scope, error) { return repository.PlanScope(ctx, user, planID) },
		"approval":   func(user uuid.UUID) (Scope, error) { return repository.ApprovalScope(ctx, user, approvalID) },
		"automation": func(user uuid.UUID) (Scope, error) { return repository.AutomationScope(ctx, user, automationID) },
		"run":        func(user uuid.UUID) (Scope, error) { return repository.AutomationRunScope(ctx, user, runID) },
	}
	for name, resolve := range resolvers {
		scope, err := resolve(memberID)
		if err != nil || scope.WorkspaceID != workspaceID || scope.Role != RoleMember {
			t.Errorf("%s scope for a member = %#v, %v", name, scope, err)
		}
		if _, err := resolve(outsiderID); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s scope for an outsider = %v, want ErrNotFound", name, err)
		}
	}
	if _, err := repository.GoalScope(ctx, memberID, archivedGoalID); !errors.Is(err, ErrNotFound) {
		t.Errorf("archived goal scope = %v, want ErrNotFound", err)
	}
	if _, err := repository.GoalScope(ctx, memberID, uuid.New()); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown goal scope = %v, want ErrNotFound", err)
	}
}
