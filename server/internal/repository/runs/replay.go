package runs

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// boardStreamTopics is what GET /api/v1/events?boardId= replays: run
// lifecycle, every issue mutation on the board, and new comments.
var boardStreamTopics = []string{
	"run.created", "run.started", "run.output.delta",
	"run.tool.started", "run.tool.completed",
	"run.usage.updated", "run.completed", "run.failed", "run.cancelled",
	"issue.created", "issue.updated", "issue.assigned",
	"issue.started", "issue.completed", "issue.deleted",
	"comment.created",
}

// ResolveRunCursor validates that a public cursor belongs to this run and is
// inside the configured retention window.
func (repository *Repository) ResolveRunCursor(
	ctx context.Context,
	runID, eventID uuid.UUID,
	cutoff time.Time,
) (int64, error) {
	if _, err := repository.Get(ctx, runID); err != nil {
		return 0, err
	}
	return ledger.ResolveCursor(ctx, repository.Pool, ledger.Runs, runID, eventID, cutoff)
}

// ListRunEvents replays authoritative PostgreSQL events after one sequence.
func (repository *Repository) ListRunEvents(
	ctx context.Context,
	runID uuid.UUID,
	afterSequence int64,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	entries, err := ledger.Replay(
		ctx, repository.Pool, ledger.Runs, runID, afterSequence, cutoff, limit,
	)
	if err != nil {
		return nil, err
	}
	result := make([]Event, 0, len(entries))
	if len(entries) == 0 {
		return result, nil
	}
	// Every event of a run carries the run's board and issue, so the workspace
	// is one lookup per non-empty batch rather than a join per row. The board
	// is the first scope column of the run ledger.
	var workspaceID uuid.UUID
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT workspace_id FROM boards WHERE id = $1`,
		entries[0].Scope[0],
	).Scan(&workspaceID); err != nil {
		return nil, errors.New("resolve run event workspace")
	}
	for _, entry := range entries {
		run := entry.OwnerID
		sequence := entry.Sequence
		result = append(result, Event{
			ID:          entry.ID,
			Type:        entry.Type,
			OccurredAt:  entry.OccurredAt,
			WorkspaceID: workspaceID,
			BoardID:     entry.Scope[0],
			IssueID:     entry.Scope[1],
			RunID:       &run,
			Sequence:    &sequence,
			Payload:     entry.Payload,
		})
	}
	return result, nil
}

// ResolveBoardCursor validates an opaque outbox event cursor in board scope.
func (repository *Repository) ResolveBoardCursor(
	ctx context.Context,
	boardID, eventID uuid.UUID,
	cutoff time.Time,
) (BoardCursor, error) {
	return ledger.ResolveOutboxCursor(
		ctx, repository.Pool, ledger.OutboxScopeBoard, boardID, boardStreamTopics, eventID, cutoff,
	)
}

// ListBoardEvents replays persisted outbox envelopes, never Valkey state.
func (repository *Repository) ListBoardEvents(
	ctx context.Context,
	boardID uuid.UUID,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	return ledger.ReplayOutbox(
		ctx, repository.Pool, ledger.OutboxScopeBoard, boardID, boardStreamTopics, after, cutoff, limit,
	)
}

// ResolveWorkspaceCursor validates an opaque outbox event cursor in workspace
// scope. The caller names the topics its stream carries, so a cursor from a
// different stream over the same workspace is refused rather than resumed.
func (repository *Repository) ResolveWorkspaceCursor(
	ctx context.Context,
	workspaceID uuid.UUID,
	topics []string,
	eventID uuid.UUID,
	cutoff time.Time,
) (BoardCursor, error) {
	return ledger.ResolveOutboxCursor(
		ctx, repository.Pool, ledger.OutboxScopeWorkspace, workspaceID, topics, eventID, cutoff,
	)
}

// ListWorkspaceEvents replays every workspace-scoped outbox envelope for the
// given topics, including facts that belong to no board. It reads through
// outbox_events_workspace_replay_idx.
func (repository *Repository) ListWorkspaceEvents(
	ctx context.Context,
	workspaceID uuid.UUID,
	topics []string,
	after *BoardCursor,
	cutoff time.Time,
	limit int,
) ([]Event, error) {
	return ledger.ReplayOutbox(
		ctx, repository.Pool, ledger.OutboxScopeWorkspace, workspaceID, topics, after, cutoff, limit,
	)
}
