package core

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ErrProjectNotFound means the project does not exist in this issue's workspace.
var ErrProjectNotFound = errors.New("project not found in this workspace")

// setIssueProject links an issue to a project, or unlinks it when nil.
//
// The link table holds one row per issue, so this is an upsert rather than an
// insert: moving an issue between projects replaces the link instead of leaving
// the issue in both.
//
// The project is checked against the issue's own workspace, not the caller's
// argument. Trusting a supplied workspace would let a request link an issue to
// a project in a workspace it can see but the issue does not belong to.
func setIssueProject(
	ctx context.Context,
	tx pgx.Tx,
	issueID uuid.UUID,
	projectID *uuid.UUID,
	linkedBy uuid.UUID,
) error {
	if projectID == nil {
		if _, err := tx.Exec(
			ctx,
			`DELETE FROM issue_project_links WHERE issue_id = $1`,
			issueID,
		); err != nil {
			return fmt.Errorf("unlink issue project: %w", err)
		}
		return nil
	}

	var workspaceID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`SELECT board.workspace_id
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		  WHERE issue.id = $1 AND issue.deleted_at IS NULL`,
		issueID,
	).Scan(&workspaceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("resolve issue workspace: %w", err)
	}

	var exists bool
	if err := tx.QueryRow(
		ctx,
		`SELECT EXISTS (
		    SELECT 1 FROM projects
		     WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
		 )`,
		*projectID, workspaceID,
	).Scan(&exists); err != nil {
		return fmt.Errorf("verify project: %w", err)
	}
	if !exists {
		return ErrProjectNotFound
	}

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO issue_project_links (workspace_id, issue_id, project_id, linked_by)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (issue_id) DO UPDATE
		    SET project_id = EXCLUDED.project_id,
		        linked_by  = EXCLUDED.linked_by`,
		workspaceID, issueID, *projectID, linkedBy,
	); err != nil {
		return fmt.Errorf("link issue project: %w", err)
	}
	return nil
}
