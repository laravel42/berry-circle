package intake

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// An issue in todo whose blocker is still open is not ready, whatever its
// status column says; once the blocker is done it is.
func TestCandidatesSkipIssuesWithOpenBlockers(t *testing.T) {
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
	now := time.Date(2026, time.August, 25, 21, 0, 0, 0, time.UTC)
	userID, workspaceID, boardID, agentID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	blockerID, dependentID := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, workspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id, email, name, role, created_at, updated_at) VALUES ($1, $2, 'Intake', 'member', $3, $3)`,
		userID, fmt.Sprintf("%s@berry.test", userID), now)
	exec(`INSERT INTO workspaces (id, name, slug, created_by, created_at, updated_at) VALUES ($1, 'Intake', $2, $3, $4, $4)`,
		workspaceID, "intake-"+workspaceID.String()[:8], userID, now)
	exec(`INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at) VALUES ($1, $2, 'admin', $3, $3)`,
		workspaceID, userID, now)
	exec(`INSERT INTO boards (id, workspace_id, name, slug, created_by, created_at, updated_at) VALUES ($1, $2, 'Intake', $3, $4, $5, $5)`,
		boardID, workspaceID, "b"+boardID.String()[:8], userID, now)
	exec(`INSERT INTO agents (id, workspace_id, openfang_agent_id, name, status, created_at, updated_at)
	      VALUES ($1, $2, gen_random_uuid(), 'Builder', 'available', $3, $3)`, agentID, workspaceID, now)
	for index, id := range []uuid.UUID{blockerID, dependentID} {
		exec(`INSERT INTO issues (id, board_id, number, title, status, priority, sort_order, assignee_type, assignee_id, created_by, created_at, updated_at)
		      VALUES ($1, $2, $3, 'Work', 'todo', 'none', 0, 'agent', $4, $5, $6, $6)`,
			id, boardID, index+1, agentID, userID, now.Add(time.Duration(index)*time.Second))
	}
	exec(`INSERT INTO issue_dependencies (workspace_id, issue_id, depends_on_issue_id, created_by, created_at) VALUES ($1, $2, $3, $4, $5)`,
		workspaceID, dependentID, blockerID, userID, now)

	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ready := func() []uuid.UUID {
		t.Helper()
		candidates, err := repository.Candidates(ctx, 50)
		if err != nil {
			t.Fatalf("Candidates() error = %v", err)
		}
		var ids []uuid.UUID
		for _, candidate := range candidates {
			if candidate.WorkspaceID == workspaceID {
				ids = append(ids, candidate.IssueID)
			}
		}
		return ids
	}
	if got := ready(); len(got) != 1 || got[0] != blockerID {
		t.Fatalf("ready = %v, want only the blocker %s", got, blockerID)
	}
	exec(`UPDATE issues SET status = 'done' WHERE id = $1`, blockerID)
	if got := ready(); len(got) != 1 || got[0] != dependentID {
		t.Fatalf("ready after blocker done = %v, want only the dependent %s", got, dependentID)
	}
}
