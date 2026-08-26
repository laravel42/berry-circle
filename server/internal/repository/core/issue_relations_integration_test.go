package core

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A list read that contains both ends of a dependency edge must describe the
// edge from both sides: the blocker on the dependent's dependsOn and the
// dependent on the blocker's blocks. Reading one side per row left blocks
// empty on every list read while the single-issue read looked fine.
func TestLoadIssueRelationsDescribesBothEndsOfAnEdge(t *testing.T) {
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
	userID, workspaceID, boardID := uuid.New(), uuid.New(), uuid.New()
	dependent, blocker := uuid.New(), uuid.New()
	now := time.Date(2000, time.January, 2, 0, 0, 0, 0, time.UTC)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM issue_dependencies WHERE issue_id = $1`, dependent)
		_, _ = pool.Exec(context.Background(), `DELETE FROM issues WHERE id = ANY($1::uuid[])`, []uuid.UUID{dependent, blocker})
		_, _ = pool.Exec(context.Background(), `DELETE FROM boards WHERE id = $1`, boardID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspace_memberships WHERE workspace_id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Relations', 'member', $3, $3)`,
		userID, fmt.Sprintf("%s@berry.test", userID), now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Relations', $2, $3, $4, $4)`,
		workspaceID, "rel-"+workspaceID.String()[:8], userID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		workspaceID, userID, now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Relations', $3, $4, $5, $5)`,
		boardID, workspaceID, "b"+boardID.String()[:8], userID, now)
	for index, id := range []uuid.UUID{blocker, dependent} {
		exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, created_by, created_at, updated_at)
		      VALUES ($1, $2, $3, $4, 'todo', 'none', 0, $5, $6, $6)`,
			id, boardID, index+1, fmt.Sprintf("Relation %d", index+1), userID, now)
	}
	exec(`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
		workspaceID, dependent, blocker, userID, now)

	relations, err := LoadIssueRelations(ctx, pool, []uuid.UUID{dependent, blocker})
	if err != nil {
		t.Fatalf("LoadIssueRelations() error = %v", err)
	}
	dependentSide, blockerSide := relations[dependent], relations[blocker]
	if len(dependentSide.DependsOn) != 1 || dependentSide.DependsOn[0].ID != blocker || dependentSide.DependsOn[0].Title != "Relation 1" ||
		dependentSide.DependsOn[0].Status != "todo" || len(dependentSide.Blocks) != 0 {
		t.Fatalf("dependent relations = %+v, want dependsOn [blocker]", dependentSide)
	}
	if len(blockerSide.Blocks) != 1 || blockerSide.Blocks[0].ID != dependent || blockerSide.Blocks[0].Title != "Relation 2" || len(blockerSide.DependsOn) != 0 {
		t.Fatalf("blocker relations = %+v, want blocks [dependent]", blockerSide)
	}
	// The single-issue read keeps working the same way.
	single, err := LoadIssueRelations(ctx, pool, []uuid.UUID{blocker})
	if err != nil || len(single[blocker].Blocks) != 1 || single[blocker].Blocks[0].ID != dependent {
		t.Fatalf("single read = %+v, %v; want blocks [dependent]", single[blocker], err)
	}
}
