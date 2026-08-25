package p2

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (repository *Repository) BatchUpdateIssues(
	ctx context.Context,
	workspaceID uuid.UUID,
	ids []uuid.UUID,
	patch BatchIssuePatch,
	now time.Time,
) ([]BatchResult, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("begin batch issue update")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	results := make([]BatchResult, 0, len(ids))
	for _, issueID := range ids {
		var currentStatus string
		err := tx.QueryRow(
			ctx,
			`SELECT issue.status::text
			   FROM issues AS issue
			   JOIN boards AS board ON board.id = issue.board_id
			    AND issue.deleted_at IS NULL
			  WHERE issue.id = $1 AND board.workspace_id = $2
			  FOR UPDATE OF issue`,
			issueID,
			workspaceID,
		).Scan(&currentStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			results = append(results, BatchResult{ID: issueID, Outcome: "notFound"})
			continue
		}
		if err != nil {
			return nil, errors.New("lock batch issue")
		}
		if patch.Status != nil && !batchTransitionAllowed(
			currentStatus,
			apiStatusToDatabase(*patch.Status),
		) {
			results = append(results, BatchResult{ID: issueID, Outcome: "conflict"})
			continue
		}
		var status, priority any
		if patch.Status != nil {
			status = apiStatusToDatabase(*patch.Status)
		}
		if patch.Priority != nil {
			priority = *patch.Priority
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE issues
			    SET status = CASE WHEN $2::boolean THEN $3::issue_status ELSE status END,
			        priority = CASE WHEN $4::boolean THEN $5::issue_priority ELSE priority END,
			        updated_at = $6
			  WHERE id = $1`,
			issueID,
			patch.Status != nil,
			status,
			patch.Priority != nil,
			priority,
			now,
		); err != nil {
			return nil, classifyWrite("batch update issue", err)
		}
		results = append(results, BatchResult{ID: issueID, Outcome: "updated"})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, errors.New("commit batch issue update")
	}
	return results, nil
}

func (repository *Repository) BatchDeleteIssues(
	ctx context.Context,
	workspaceID uuid.UUID,
	ids []uuid.UUID,
	now time.Time,
) ([]BatchResult, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, errors.New("begin batch issue deletion")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	results := make([]BatchResult, 0, len(ids))
	for _, issueID := range ids {
		tag, err := tx.Exec(
			ctx,
			// Soft, like the single-issue delete. A row removal here cascades
			// through twelve foreign keys — runs, run_events and attachments
			// among them — and the attachment cascade never calls the two-phase
			// delete that removes the object, so every artifact's bytes would be
			// orphaned in storage. It would also free the issue number for reuse,
			// and an identifier that names two different issues over time makes
			// run and audit history ambiguous.
			`UPDATE issues AS issue
			    SET deleted_at = $3, updated_at = $3
			  FROM boards AS board
			  WHERE issue.id = $1
			    AND board.id = issue.board_id
			    AND board.workspace_id = $2
			    AND issue.deleted_at IS NULL`,
			issueID,
			workspaceID,
			now.UTC(),
		)
		if err != nil {
			return nil, errors.New("batch delete issue")
		}
		outcome := "deleted"
		if tag.RowsAffected() != 1 {
			outcome = "notFound"
		}
		results = append(results, BatchResult{ID: issueID, Outcome: outcome})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, errors.New("commit batch issue deletion")
	}
	return results, nil
}

func batchTransitionAllowed(from, to string) bool {
	if from == to {
		return true
	}
	allowed := map[string][]string{
		"backlog":     {"todo", "cancelled"},
		"todo":        {"backlog", "in_progress", "blocked", "cancelled"},
		"in_progress": {"todo", "in_review", "blocked", "cancelled"},
		"in_review":   {"in_progress", "done", "blocked", "cancelled"},
		"done":        {"in_review"},
		"blocked":     {"todo", "in_progress", "cancelled"},
		"cancelled":   {"backlog", "todo"},
	}
	for _, candidate := range allowed[from] {
		if candidate == to {
			return true
		}
	}
	return false
}
