package automationrun

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// publish delivers committed ledger facts live. The rows are already durable
// and replayable; this only wakes subscribers, so a failure is not an error.
func (runner *Runner) publish(ctx context.Context, events ...ledger.Event) {
	if runner.options.Broadcaster == nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, event := range events {
		if event.ID == uuid.Nil {
			continue
		}
		_ = runner.options.Broadcaster.Publish(publishCtx, realtime.Event{
			ID:          event.ID.String(),
			WorkspaceID: event.WorkspaceID.String(),
			BoardID:     boardScope(event.BoardID),
			Type:        event.Type,
			Payload:     event.Payload,
			OccurredAt:  event.OccurredAt,
		})
	}
}

func (runner *Runner) publishIssues(ctx context.Context, events []core.IssueMutationEvent) {
	converted := make([]ledger.Event, 0, len(events))
	for _, event := range events {
		converted = append(converted, ledger.Event{
			ID: event.ID, Type: event.Type, OccurredAt: event.OccurredAt, WorkspaceID: event.WorkspaceID,
			BoardID: event.BoardID, IssueID: event.IssueID, Payload: event.Payload,
		})
	}
	runner.publish(ctx, converted...)
}

func (runner *Runner) publishComment(ctx context.Context, event core.CommentMutationEvent) {
	runner.publish(ctx, ledger.Event{
		ID: event.ID, Type: event.Type, OccurredAt: event.OccurredAt, WorkspaceID: event.WorkspaceID,
		BoardID: event.BoardID, IssueID: event.IssueID, Payload: event.Payload,
	})
}

func boardScope(boardID uuid.UUID) string {
	if boardID == uuid.Nil {
		return ""
	}
	return boardID.String()
}
