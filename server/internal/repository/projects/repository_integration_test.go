package projects

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

func TestPostgresProjectResourceAndIssueLinkIsolation(t *testing.T) {
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

	now := time.Date(2026, time.August, 22, 18, 0, 0, 0, time.UTC)
	userID := uuid.New()
	workspaceID, otherWorkspaceID := uuid.New(), uuid.New()
	boardID, issueID := uuid.New(), uuid.New()
	projectID, otherProjectID, resourceID := uuid.New(), uuid.New(), uuid.New()
	t.Cleanup(func() {
		_, _ = pool.Exec(
			context.Background(),
			`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`,
			[]uuid.UUID{workspaceID, otherWorkspaceID},
		)
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO users (id, email, name, role, created_at, updated_at)
		 VALUES ($1, $2, 'Project Repository Test', 'member', $3, $3)`,
		userID,
		fmt.Sprintf("%s@berry.test", userID),
		now,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	for _, workspaceID := range []uuid.UUID{workspaceID, otherWorkspaceID} {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspaces (
			    id, name, slug, created_by, created_at, updated_at
			 ) VALUES ($1, 'Project Repository Test', $2, $3, $4, $4)`,
			workspaceID,
			"project-"+workspaceID.String()[:8],
			userID,
			now,
		); err != nil {
			t.Fatalf("seed workspace: %v", err)
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO workspace_memberships (
			    workspace_id, user_id, role, joined_at, updated_at
			 ) VALUES ($1, $2, 'owner', $3, $3)`,
			workspaceID,
			userID,
			now,
		); err != nil {
			t.Fatalf("seed membership: %v", err)
		}
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO boards (
		    id, workspace_id, name, slug, columns, created_by, created_at, updated_at
		 ) VALUES ($1, $2, 'Project Link Board', $3, '[]'::jsonb, $4, $5, $5)`,
		boardID,
		workspaceID,
		"project-link-"+boardID.String()[:8],
		userID,
		now,
	); err != nil {
		t.Fatalf("seed board: %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO issues (
		    id, board_id, number, title, created_by, created_at, updated_at
		 ) VALUES ($1, $2, 1, 'Project Link Issue', $3, $4, $4)`,
		issueID,
		boardID,
		userID,
		now,
	); err != nil {
		t.Fatalf("seed issue: %v", err)
	}

	project, err := repository.Create(ctx, CreateParams{
		ID:          projectID,
		WorkspaceID: workspaceID,
		Name:        "P2 work management",
		Status:      StatusActive,
		Priority:    PriorityHigh,
		CreatedBy:   userID,
		CreatedAt:   now,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if project.WorkspaceID != workspaceID {
		t.Fatalf("created workspace=%s, want %s", project.WorkspaceID, workspaceID)
	}
	if _, err := repository.Get(ctx, otherWorkspaceID, projectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace Get() error = %v, want not found", err)
	}
	resource, err := repository.CreateResource(ctx, CreateResourceParams{
		ID:          resourceID,
		WorkspaceID: workspaceID,
		ProjectID:   projectID,
		Kind:        ResourceRepository,
		URL:         "https://example.com/berry/p2",
		SortOrder:   1000,
		CreatedBy:   userID,
		CreatedAt:   now,
	})
	if err != nil {
		t.Fatalf("CreateResource() error = %v", err)
	}
	if resource.ProjectID != projectID {
		t.Fatalf("resource project=%s, want %s", resource.ProjectID, projectID)
	}
	if err := repository.LinkIssue(
		ctx,
		workspaceID,
		issueID,
		projectID,
		userID,
		now,
	); err != nil {
		t.Fatalf("LinkIssue() error = %v", err)
	}
	linked, err := repository.ProjectForIssue(ctx, workspaceID, issueID)
	if err != nil {
		t.Fatalf("ProjectForIssue() error = %v", err)
	}
	if linked.ID != projectID {
		t.Fatalf("linked project=%s, want %s", linked.ID, projectID)
	}

	if _, err := repository.Create(ctx, CreateParams{
		ID:          otherProjectID,
		WorkspaceID: otherWorkspaceID,
		Name:        "Other workspace",
		Status:      StatusPlanned,
		Priority:    PriorityNone,
		CreatedBy:   userID,
		CreatedAt:   now,
	}); err != nil {
		t.Fatalf("create other workspace project: %v", err)
	}
	if err := repository.LinkIssue(
		ctx,
		workspaceID,
		issueID,
		otherProjectID,
		userID,
		now,
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace LinkIssue() error = %v, want not found", err)
	}
	if err := repository.Archive(ctx, workspaceID, projectID, now.Add(time.Hour)); err != nil {
		t.Fatalf("Archive() error = %v", err)
	}
	if _, err := repository.Get(ctx, workspaceID, projectID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get() archived error = %v, want not found", err)
	}
}
