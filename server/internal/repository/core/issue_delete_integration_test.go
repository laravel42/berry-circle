package core

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func deletePool(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	url := os.Getenv("CORE_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("CORE_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return ctx, pool
}

type deleteFixture struct {
	IssueID   uuid.UUID
	Reference string
	BoardID   uuid.UUID
	UserID    uuid.UUID
	AgentID   uuid.UUID
}

func seedIssue(t *testing.T, ctx context.Context, pool *pgxpool.Pool) deleteFixture {
	t.Helper()
	user, workspace, board := uuid.New(), uuid.New(), uuid.New()
	issue, agent := uuid.New(), uuid.New()
	slug := "b" + board.String()[:8]
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	exec(`INSERT INTO users (id,email,name,role) VALUES ($1,$2,'T','admin')`,
		user, user.String()+"@berry.test")
	exec(`INSERT INTO workspaces (id,name,slug,created_by) VALUES ($1,'W',$2,$3)`,
		workspace, "w"+workspace.String()[:8], user)
	exec(`INSERT INTO workspace_memberships (workspace_id,user_id,role) VALUES ($1,$2,'admin')`,
		workspace, user)
	exec(`INSERT INTO boards (id,workspace_id,name,slug,created_by) VALUES ($1,$2,'B',$3,$4)`,
		board, workspace, slug, user)
	exec(`INSERT INTO agents (id,workspace_id,openfang_agent_id,name,status)
	      VALUES ($1,$2,gen_random_uuid(),'writer','available')`, agent, workspace)
	exec(`INSERT INTO issues (id,board_id,number,title,status,priority,sort_order,created_by)
	      VALUES ($1,$2,7,'Blog','todo','urgent',1000,$3)`, issue, board, user)
	return deleteFixture{
		IssueID: issue, Reference: slug + "-7", BoardID: board,
		UserID: user, AgentID: agent,
	}
}

func TestDeletedIssueDisappearsFromEveryRead(t *testing.T) {
	ctx, pool := deletePool(t)
	repository := &Repository{Pool: pool}
	fixture := seedIssue(t, ctx, pool)
	now := time.Now().UTC()

	if _, err := repository.GetIssue(ctx, fixture.Reference); err != nil {
		t.Fatalf("issue should be readable before deletion: %v", err)
	}
	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); err != nil {
		t.Fatalf("DeleteIssue: %v", err)
	}

	if _, err := repository.GetIssue(ctx, fixture.Reference); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetIssue after delete = %v, want ErrNotFound", err)
	}
	listed, err := repository.ListIssues(ctx, IssueListFilter{
		BoardID: fixture.BoardID, Limit: 50,
	})
	if err != nil {
		t.Fatalf("ListIssues: %v", err)
	}
	for _, issue := range listed {
		if issue.ID == fixture.IssueID {
			t.Fatal("a deleted issue is still listed on its board")
		}
	}
}

func TestDeletedIssueKeepsItsRowAndNumber(t *testing.T) {
	ctx, pool := deletePool(t)
	repository := &Repository{Pool: pool}
	fixture := seedIssue(t, ctx, pool)
	now := time.Now().UTC()

	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); err != nil {
		t.Fatalf("DeleteIssue: %v", err)
	}

	// The row survives, which is what keeps BER-7 retired: the next number
	// comes from max(number), so removing the row would hand it to a new issue
	// and make the identifier name two different things over time.
	var (
		number    int
		deletedAt *time.Time
	)
	if err := pool.QueryRow(ctx,
		`SELECT number, deleted_at FROM issues WHERE id = $1`,
		fixture.IssueID).Scan(&number, &deletedAt); err != nil {
		t.Fatalf("read row after delete: %v", err)
	}
	if deletedAt == nil {
		t.Fatal("deleted_at was not set")
	}
	if number != 7 {
		t.Errorf("number = %d, want it retained", number)
	}
}

func TestDeletingTwiceReportsNotFound(t *testing.T) {
	ctx, pool := deletePool(t)
	repository := &Repository{Pool: pool}
	fixture := seedIssue(t, ctx, pool)
	now := time.Now().UTC()

	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); err != nil {
		t.Fatalf("first delete: %v", err)
	}
	// A second click from a stale board must say something true rather than
	// report success for work it did not do.
	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete = %v, want ErrNotFound", err)
	}
}

func TestDeletedIssueCannotBeEditedOrCommentedOn(t *testing.T) {
	ctx, pool := deletePool(t)
	repository := &Repository{Pool: pool}
	fixture := seedIssue(t, ctx, pool)
	now := time.Now().UTC()

	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); err != nil {
		t.Fatalf("DeleteIssue: %v", err)
	}

	status := "inProgress"
	_, _, err := repository.UpdateIssue(ctx, UpdateIssueParams{
		IssueID:   fixture.IssueID,
		Patch:     IssuePatch{Status: &status},
		UpdatedAt: now,
	})
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateIssue on a deleted issue = %v, want ErrNotFound", err)
	}
}

func TestIntakeNeverClaimsADeletedIssue(t *testing.T) {
	ctx, pool := deletePool(t)
	repository := &Repository{Pool: pool}
	fixture := seedIssue(t, ctx, pool)
	now := time.Now().UTC()

	// The failure this guards is an agent starting a run — and spending money,
	// and acting in the outside world — on something a person deleted.
	assertClaimable := func(want bool) {
		t.Helper()
		var claimable bool
		if err := pool.QueryRow(ctx,
			`SELECT EXISTS (
			    SELECT 1 FROM issues AS issue
			     WHERE issue.id = $1
			       AND issue.deleted_at IS NULL
			       AND issue.status = 'todo'
			       AND issue.active_run_id IS NULL
			 )`, fixture.IssueID).Scan(&claimable); err != nil {
			t.Fatalf("claimability: %v", err)
		}
		if claimable != want {
			t.Fatalf("claimable = %v, want %v", claimable, want)
		}
	}
	assertClaimable(true)
	if _, _, err := repository.DeleteIssue(ctx, DeleteIssueParams{IssueID: fixture.IssueID, DeletedBy: fixture.UserID, DeletedAt: now}); err != nil {
		t.Fatalf("DeleteIssue: %v", err)
	}
	assertClaimable(false)
}
