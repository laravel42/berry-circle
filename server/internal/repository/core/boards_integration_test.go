package core

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestListBoardsFiltersByActiveWorkspaceMembership(t *testing.T) {
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
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("ping BERRY_TEST_DATABASE_URL: %v", err)
	}
	repository, err := New(pool)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	now := time.Date(2026, time.August, 22, 12, 0, 0, 0, time.UTC)
	memberID, outsiderID := uuid.New(), uuid.New()
	memberWorkspaceID, outsiderWorkspaceID := uuid.New(), uuid.New()
	memberBoardID, outsiderBoardID := uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM boards WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{memberBoardID, outsiderBoardID},
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{memberWorkspaceID, outsiderWorkspaceID},
		)
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM users WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{memberID, outsiderID},
		)
	})
	for id, email := range map[uuid.UUID]string{
		memberID:   "member-" + memberID.String() + "@berry.test",
		outsiderID: "outsider-" + outsiderID.String() + "@berry.test",
	} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO users (id, email, name, role, created_at, updated_at)
			 VALUES ($1, $2, 'Board Scope Test', 'member', $3, $3)`,
			id,
			email,
			now,
		); err != nil {
			t.Fatalf("seed user: %v", err)
		}
	}
	for _, seeded := range []struct {
		workspaceID uuid.UUID
		ownerID     uuid.UUID
		slug        string
	}{
		{memberWorkspaceID, memberID, "member-" + memberWorkspaceID.String()[:8]},
		{outsiderWorkspaceID, outsiderID, "outsider-" + outsiderWorkspaceID.String()[:8]},
	} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspaces (
			    id, name, slug, created_by, created_at, updated_at
			 ) VALUES ($1, 'Board Scope Test', $2, $3, $4, $4)`,
			seeded.workspaceID,
			seeded.slug,
			seeded.ownerID,
			now,
		); err != nil {
			t.Fatalf("seed workspace: %v", err)
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspace_memberships (
			    workspace_id, user_id, role, joined_at, updated_at
			 ) VALUES ($1, $2, 'owner', $3, $3)`,
			seeded.workspaceID,
			seeded.ownerID,
			now,
		); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	for _, seeded := range []struct {
		boardID     uuid.UUID
		workspaceID uuid.UUID
		ownerID     uuid.UUID
		slug        string
	}{
		{memberBoardID, memberWorkspaceID, memberID, "mb-" + memberBoardID.String()[:8]},
		{outsiderBoardID, outsiderWorkspaceID, outsiderID, "ob-" + outsiderBoardID.String()[:8]},
	} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO boards (
			    id, workspace_id, name, slug, columns, created_by,
			    created_at, updated_at
			 ) VALUES ($1, $2, 'Board Scope Test', $3, '[]', $4, $5, $5)`,
			seeded.boardID,
			seeded.workspaceID,
			seeded.slug,
			seeded.ownerID,
			now,
		); err != nil {
			t.Fatalf("seed board: %v", err)
		}
	}

	found, err := repository.ListBoards(ctx, memberID, nil, 100)
	if err != nil {
		t.Fatalf("ListBoards() error = %v", err)
	}
	var ownFound, outsiderFound bool
	for _, board := range found {
		ownFound = ownFound || board.ID == memberBoardID
		outsiderFound = outsiderFound || board.ID == outsiderBoardID
	}
	if !ownFound || outsiderFound {
		t.Fatalf("ownFound=%t outsiderFound=%t", ownFound, outsiderFound)
	}
}
