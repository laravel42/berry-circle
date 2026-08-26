package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

// ResolveComment marks one comment as the thread resolution. A prior resolved
// sibling is atomically cleared so the database invariant remains true.
func (repository *Repository) ResolveComment(
	ctx context.Context,
	actorID, commentID, resolvedEventID, displacedEventID uuid.UUID,
	resolvedAt time.Time,
) (ResolutionResult, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ResolutionResult{}, errors.New("begin comment resolution")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	access, err := authorizeComment(
		ctx,
		tx,
		actorID,
		commentID,
		identity.PermissionCommentWrite,
		true,
	)
	if err != nil {
		return ResolutionResult{}, err
	}
	var resolver Actor
	if err := tx.QueryRow(
		ctx,
		`SELECT id, name, avatar_url FROM users WHERE id = $1 FOR KEY SHARE`,
		actorID,
	).Scan(&resolver.ID, &resolver.Name, &resolver.AvatarURL); err != nil {
		return ResolutionResult{}, classifyReadError("read comment resolver", err)
	}
	var (
		currentAt *time.Time
		currentBy *uuid.UUID
		revision  int64
		threadID  uuid.UUID
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT COALESCE(parent_id, id) FROM comments WHERE id = $1`,
		commentID,
	).Scan(&threadID); err != nil {
		return ResolutionResult{}, classifyReadError("read comment thread", err)
	}
	if _, err := tx.Exec(
		ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
		access.IssueID.String()+":"+threadID.String(),
	); err != nil {
		return ResolutionResult{}, classifyWriteError("lock comment thread", err)
	}
	if err := tx.QueryRow(
		ctx,
		`SELECT resolved_at, resolved_by, revision
		   FROM comments
		  WHERE id = $1
		  FOR UPDATE`,
		commentID,
	).Scan(&currentAt, &currentBy, &revision); err != nil {
		return ResolutionResult{}, classifyReadError("lock comment resolution target", err)
	}
	if currentAt != nil {
		var priorResolver *Actor
		if currentBy != nil {
			if *currentBy == resolver.ID {
				priorResolver = &resolver
			} else {
				var actor Actor
				err := tx.QueryRow(
					ctx,
					`SELECT id, name, avatar_url FROM users WHERE id = $1`,
					*currentBy,
				).Scan(&actor.ID, &actor.Name, &actor.AvatarURL)
				if err == nil {
					priorResolver = &actor
				} else if !errors.Is(err, pgx.ErrNoRows) {
					return ResolutionResult{}, classifyReadError(
						"read prior comment resolver",
						err,
					)
				}
			}
		}
		resolution := Resolution{
			CommentID: commentID,
			IssueID:   access.IssueID,
			Revision:  revision,
			Resolved:  true,
			At:        currentAt,
			By:        priorResolver,
		}
		if err := tx.Commit(ctx); err != nil {
			return ResolutionResult{}, errors.New("commit idempotent comment resolution")
		}
		return ResolutionResult{Resolution: resolution}, nil
	}
	var events []Event
	var (
		displacedID       uuid.UUID
		displacedRevision int64
	)
	err = tx.QueryRow(
		ctx,
		`UPDATE comments
		    SET resolved_at = NULL,
		        resolved_by = NULL,
		        revision = revision + 1
		  WHERE issue_id = $1
		    AND COALESCE(parent_id, id) = $2
		    AND resolved_at IS NOT NULL
		    AND id <> $3
		  RETURNING id, revision`,
		access.IssueID,
		threadID,
		commentID,
	).Scan(&displacedID, &displacedRevision)
	switch {
	case err == nil:
		event, eventErr := makeEvent(
			displacedEventID,
			access.WorkspaceID,
			access.BoardID,
			"comment.unresolved",
			"comment",
			displacedID,
			resolutionEventPayload(
				displacedID,
				access.IssueID,
				displacedRevision,
				false,
				nil,
				nil,
			),
			resolvedAt,
		)
		if eventErr != nil {
			return ResolutionResult{}, eventErr
		}
		if err := insertOutboxEvent(ctx, tx, event); err != nil {
			return ResolutionResult{}, err
		}
		events = append(events, event)
	case errors.Is(err, pgx.ErrNoRows):
	default:
		return ResolutionResult{}, classifyWriteError("clear prior comment resolution", err)
	}
	var storedAt time.Time
	if err := tx.QueryRow(
		ctx,
		`UPDATE comments
		    SET resolved_at = $2,
		        resolved_by = $3,
		        revision = revision + 1
		  WHERE id = $1
		  RETURNING resolved_at, revision`,
		commentID,
		resolvedAt.UTC(),
		actorID,
	).Scan(&storedAt, &revision); err != nil {
		return ResolutionResult{}, classifyWriteError("resolve comment", err)
	}
	resolution := Resolution{
		CommentID: commentID,
		IssueID:   access.IssueID,
		Revision:  revision,
		Resolved:  true,
		At:        &storedAt,
		By:        &resolver,
	}
	event, err := makeEvent(
		resolvedEventID,
		access.WorkspaceID,
		access.BoardID,
		"comment.resolved",
		"comment",
		commentID,
		resolutionEventPayload(
			commentID,
			access.IssueID,
			revision,
			true,
			&storedAt,
			&resolver,
		),
		resolvedAt,
	)
	if err != nil {
		return ResolutionResult{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return ResolutionResult{}, err
	}
	events = append(events, event)
	if err := tx.Commit(ctx); err != nil {
		return ResolutionResult{}, errors.New("commit comment resolution")
	}
	return ResolutionResult{Resolution: resolution, Events: events}, nil
}

// UnresolveComment clears a resolution idempotently.
func (repository *Repository) UnresolveComment(
	ctx context.Context,
	actorID, commentID, eventID uuid.UUID,
	unresolvedAt time.Time,
) (ResolutionResult, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return ResolutionResult{}, errors.New("begin comment unresolve")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	access, err := authorizeComment(
		ctx,
		tx,
		actorID,
		commentID,
		identity.PermissionCommentWrite,
		true,
	)
	if err != nil {
		return ResolutionResult{}, err
	}
	var (
		resolvedAt *time.Time
		revision   int64
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT resolved_at, revision
		   FROM comments
		  WHERE id = $1
		  FOR UPDATE`,
		commentID,
	).Scan(&resolvedAt, &revision); err != nil {
		return ResolutionResult{}, classifyReadError("lock comment unresolve target", err)
	}
	if resolvedAt == nil {
		resolution := Resolution{
			CommentID: commentID,
			IssueID:   access.IssueID,
			Revision:  revision,
			Resolved:  false,
		}
		if err := tx.Commit(ctx); err != nil {
			return ResolutionResult{}, errors.New("commit idempotent comment unresolve")
		}
		return ResolutionResult{Resolution: resolution}, nil
	}
	if err := tx.QueryRow(
		ctx,
		`UPDATE comments
		    SET resolved_at = NULL,
		        resolved_by = NULL,
		        revision = revision + 1
		  WHERE id = $1
		  RETURNING revision`,
		commentID,
	).Scan(&revision); err != nil {
		return ResolutionResult{}, classifyWriteError("unresolve comment", err)
	}
	resolution := Resolution{
		CommentID: commentID,
		IssueID:   access.IssueID,
		Revision:  revision,
		Resolved:  false,
	}
	event, err := makeEvent(
		eventID,
		access.WorkspaceID,
		access.BoardID,
		"comment.unresolved",
		"comment",
		commentID,
		resolutionEventPayload(
			commentID,
			access.IssueID,
			revision,
			false,
			nil,
			nil,
		),
		unresolvedAt,
	)
	if err != nil {
		return ResolutionResult{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return ResolutionResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ResolutionResult{}, errors.New("commit comment unresolve")
	}
	return ResolutionResult{Resolution: resolution, Events: []Event{event}}, nil
}

func resolutionEventPayload(
	commentID, issueID uuid.UUID,
	revision int64,
	resolved bool,
	resolvedAt *time.Time,
	resolvedBy *Actor,
) any {
	var occurredAt *string
	if resolvedAt != nil {
		formatted := resolvedAt.UTC().Format(time.RFC3339Nano)
		occurredAt = &formatted
	}
	return struct {
		CommentID    uuid.UUID  `json:"commentId"`
		IssueID      uuid.UUID  `json:"issueId"`
		Revision     int64      `json:"revision"`
		Resolved     bool       `json:"resolved"`
		ResolvedAt   *string    `json:"resolvedAt"`
		ResolvedByID *uuid.UUID `json:"resolvedById"`
	}{
		CommentID:    commentID,
		IssueID:      issueID,
		Revision:     revision,
		Resolved:     resolved,
		ResolvedAt:   occurredAt,
		ResolvedByID: actorIDPointer(resolvedBy),
	}
}

func actorIDPointer(actor *Actor) *uuid.UUID {
	if actor == nil {
		return nil
	}
	id := actor.ID
	return &id
}
