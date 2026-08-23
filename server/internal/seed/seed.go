package seed

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Apply inserts the local development dataset when it is missing. Every step is
// idempotent so the command is safe to run after migrations on every boot.
func Apply(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	if pool == nil {
		return fmt.Errorf("seed pool is nil")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin seed transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	if err := upsertUser(ctx, tx, now); err != nil {
		return err
	}
	if err := upsertWorkspace(ctx, tx, now); err != nil {
		return err
	}
	if err := upsertMembership(ctx, tx, now); err != nil {
		return err
	}
	if err := setUserLastWorkspace(ctx, tx, now); err != nil {
		return err
	}
	if err := upsertBoard(ctx, tx, now); err != nil {
		return err
	}
	if err := upsertIssues(ctx, tx, now); err != nil {
		return err
	}
	if err := upsertProjects(ctx, tx, now); err != nil {
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit seed transaction: %w", err)
	}
	return nil
}

func upsertUser(ctx context.Context, tx pgx.Tx, now time.Time) error {
	_, err := tx.Exec(
		ctx,
		`UPDATE users
		    SET email = 'replaced-' || id::text || '@berry.test'
		  WHERE lower(email) = lower($1)
		    AND id <> $2`,
		UserEmail,
		UserID,
	)
	if err != nil {
		return fmt.Errorf("seed user email conflict cleanup: %w", err)
	}
	_, err = tx.Exec(
		ctx,
		`INSERT INTO users (
		    id, email, name, role, settings, onboarding_state,
		    onboarding_completed_at, last_workspace_id, created_at, updated_at
		 ) VALUES (
		    $1, $2, $3, 'admin',
		    '{"theme":"system","timezone":"UTC","reducedMotion":false}'::jsonb,
		    '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
		    $4, NULL, $4, $4
		 )
		 ON CONFLICT (id) DO UPDATE SET
		    email = EXCLUDED.email,
		    name = EXCLUDED.name,
		    role = EXCLUDED.role,
		    updated_at = EXCLUDED.updated_at`,
		UserID,
		UserEmail,
		UserName,
		now,
	)
	if err != nil {
		return fmt.Errorf("seed user: %w", err)
	}
	return nil
}

func setUserLastWorkspace(ctx context.Context, tx pgx.Tx, now time.Time) error {
	_, err := tx.Exec(
		ctx,
		`UPDATE users
		    SET last_workspace_id = $2, updated_at = $3
		  WHERE id = $1`,
		UserID,
		WorkspaceID,
		now,
	)
	if err != nil {
		return fmt.Errorf("seed user last workspace: %w", err)
	}
	return nil
}

func upsertWorkspace(ctx context.Context, tx pgx.Tx, now time.Time) error {
	_, err := tx.Exec(
		ctx,
		`UPDATE workspaces
		    SET slug = 'replaced-' || id::text
		  WHERE lower(slug) = lower($1)
		    AND id <> $2
		    AND deleted_at IS NULL`,
		WorkspaceSlug,
		WorkspaceID,
	)
	if err != nil {
		return fmt.Errorf("seed workspace slug conflict cleanup: %w", err)
	}
	_, err = tx.Exec(
		ctx,
		`INSERT INTO workspaces (
		    id, name, slug, description, settings, created_by, created_at, updated_at
		 ) VALUES (
		    $1, $2, $3, 'Local Berry workspace',
		    '{"issuePrefix":"BERRY","defaultRole":"member","allowMemberInvites":false}'::jsonb,
		    $4, $5, $5
		 )
		 ON CONFLICT (id) DO UPDATE SET
		    name = EXCLUDED.name,
		    slug = EXCLUDED.slug,
		    description = EXCLUDED.description,
		    updated_at = EXCLUDED.updated_at`,
		WorkspaceID,
		WorkspaceName,
		WorkspaceSlug,
		UserID,
		now,
	)
	if err != nil {
		return fmt.Errorf("seed workspace: %w", err)
	}
	return nil
}

func upsertMembership(ctx context.Context, tx pgx.Tx, now time.Time) error {
	_, err := tx.Exec(
		ctx,
		`INSERT INTO workspace_memberships (
		    workspace_id, user_id, role, joined_at, updated_at
		 ) VALUES ($1, $2, 'owner', $3, $3)
		 ON CONFLICT (workspace_id, user_id) DO UPDATE SET
		    role = EXCLUDED.role,
		    updated_at = EXCLUDED.updated_at`,
		WorkspaceID,
		UserID,
		now,
	)
	if err != nil {
		return fmt.Errorf("seed workspace membership: %w", err)
	}
	return nil
}

func upsertBoard(ctx context.Context, tx pgx.Tx, now time.Time) error {
	_, err := tx.Exec(
		ctx,
		`UPDATE boards
		    SET slug = 'replaced-' || id::text
		  WHERE lower(slug) = lower($1)
		    AND id <> $2`,
		BoardSlug,
		BoardID,
	)
	if err != nil {
		return fmt.Errorf("seed board slug conflict cleanup: %w", err)
	}
	_, err = tx.Exec(
		ctx,
		`INSERT INTO boards (
		    id, workspace_id, name, slug, description, columns, issue_counter,
		    created_by, created_at, updated_at
		 ) VALUES (
		    $1, $2, $3, $4, 'Default development crew board', '[]'::jsonb, 3,
		    $5, $6, $6
		 )
		 ON CONFLICT (id) DO UPDATE SET
		    workspace_id = EXCLUDED.workspace_id,
		    name = EXCLUDED.name,
		    slug = EXCLUDED.slug,
		    description = EXCLUDED.description,
		    updated_at = EXCLUDED.updated_at`,
		BoardID,
		WorkspaceID,
		BoardName,
		BoardSlug,
		UserID,
		now,
	)
	if err != nil {
		return fmt.Errorf("seed board: %w", err)
	}
	return nil
}

func upsertIssues(ctx context.Context, tx pgx.Tx, now time.Time) error {
	issues := []struct {
		id       string
		number   int
		title    string
		status   string
		priority string
		sort     int
	}{
		{
			id:       "11111111-1111-4111-8111-111111111201",
			number:   1,
			title:    "Wire OpenFang runtime probes",
			status:   "todo",
			priority: "high",
			sort:     1000,
		},
		{
			id:       "11111111-1111-4111-8111-111111111202",
			number:   2,
			title:    "Match projects board to issues Kanban",
			status:   "in_progress",
			priority: "medium",
			sort:     2000,
		},
		{
			id:       "11111111-1111-4111-8111-111111111203",
			number:   3,
			title:    "Seed local development data",
			status:   "done",
			priority: "low",
			sort:     3000,
		},
	}
	for _, issue := range issues {
		_, err := tx.Exec(
			ctx,
			`INSERT INTO issues (
			    id, board_id, number, title, description, status, priority, sort_order,
			    created_by, created_at, updated_at
			 ) VALUES (
			    $1, $2, $3, $4, $5, $6::issue_status, $7::issue_priority, $8,
			    $9, $10, $10
			 )
			 ON CONFLICT (id) DO UPDATE SET
			    title = EXCLUDED.title,
			    status = EXCLUDED.status,
			    priority = EXCLUDED.priority,
			    sort_order = EXCLUDED.sort_order,
			    updated_at = EXCLUDED.updated_at`,
			issue.id,
			BoardID,
			issue.number,
			issue.title,
			"Seeded for local Berry development.",
			issue.status,
			issue.priority,
			issue.sort,
			UserID,
			now,
		)
		if err != nil {
			return fmt.Errorf("seed issue %d: %w", issue.number, err)
		}
	}
	return nil
}

func upsertProjects(ctx context.Context, tx pgx.Tx, now time.Time) error {
	projects := []struct {
		id       string
		name     string
		status   string
		priority string
	}{
		{
			id:       "11111111-1111-4111-8111-111111111301",
			name:     "Agent runtime",
			status:   "active",
			priority: "high",
		},
		{
			id:       "11111111-1111-4111-8111-111111111302",
			name:     "Projects parity",
			status:   "planned",
			priority: "medium",
		},
		{
			id:       "11111111-1111-4111-8111-111111111303",
			name:     "Workspace bootstrap",
			status:   "completed",
			priority: "low",
		},
	}
	for _, project := range projects {
		_, err := tx.Exec(
			ctx,
			`INSERT INTO projects (
			    id, workspace_id, name, description, status, priority,
			    start_date, target_date, created_by, created_at, updated_at
			 ) VALUES (
			    $1, $2, $3, $4, $5, $6, CURRENT_DATE - 7, CURRENT_DATE + 21, $7, $8, $8
			 )
			 ON CONFLICT (id) DO UPDATE SET
			    name = EXCLUDED.name,
			    status = EXCLUDED.status,
			    priority = EXCLUDED.priority,
			    updated_at = EXCLUDED.updated_at`,
			project.id,
			WorkspaceID,
			project.name,
			"Seeded for local Berry development.",
			project.status,
			project.priority,
			UserID,
			now,
		)
		if err != nil {
			return fmt.Errorf("seed project %q: %w", project.name, err)
		}
	}
	return nil
}
