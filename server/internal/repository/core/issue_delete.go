package core

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// DeleteIssue marks an issue deleted without destroying it.
//
// Soft for two reasons the schema cannot express. The issue's number is part of
// its identity — BER-4 appears in run history, audit rows and links — and
// the next number comes from max(number) on the board, so removing the row
// would hand the number to the next issue created. And twelve foreign keys
// cascade from here, including runs, run_events and attachments, whose bytes
// live in object storage and would be orphaned by a cascade that never calls
// the two-phase attachment delete.
//
// Deleting an already-deleted issue reports not-found rather than succeeding
// quietly, so a caller can tell "I deleted it" from "it was already gone" —
// which is what makes a second click from a stale list say something true.
//
// The issue.deleted outbox row is written in the same transaction; the caller
// publishes it live after commit.
func (repository *Repository) DeleteIssue(
	ctx context.Context,
	params DeleteIssueParams,
) (Issue, []IssueMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Issue{}, nil, fmt.Errorf("begin issue delete: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	// Read before writing so the caller receives what was deleted: the response
	// names the issue, and after the update the projection would exclude it.
	issue, err := getIssueByID(ctx, tx, params.IssueID, true)
	if err != nil {
		return Issue{}, nil, err
	}

	tag, err := tx.Exec(
		ctx,
		`UPDATE issues
		    SET deleted_at = $2, updated_at = $2
		  WHERE id = $1 AND deleted_at IS NULL`,
		params.IssueID, params.DeletedAt.UTC(),
	)
	if err != nil {
		return Issue{}, nil, fmt.Errorf("delete issue: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return Issue{}, nil, ErrNotFound
	}
	events, err := RecordIssueEvents(ctx, tx, IssueEventParams{
		IssueID:    params.IssueID,
		Kind:       IssueEventDeleted,
		Actor:      &ActorKey{Type: "user", ID: params.DeletedBy},
		OccurredAt: params.DeletedAt,
		NewID:      params.NewID,
	})
	if err != nil {
		return Issue{}, nil, err
	}

	// An in-flight run is left to finish. Cancelling it here would mean a
	// delete could fail because a model call was mid-stream, and the run's
	// record is retained anyway — what it did in the outside world happened
	// whether or not the issue survives.
	if err := tx.Commit(ctx); err != nil {
		return Issue{}, nil, fmt.Errorf("commit issue delete: %w", err)
	}
	return issue, events, nil
}
