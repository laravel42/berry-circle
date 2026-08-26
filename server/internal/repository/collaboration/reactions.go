package collaboration

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

// AddIssueReaction inserts at most one actor/emoji row and persists an outbox
// event only when the durable set changed.
func (repository *Repository) AddIssueReaction(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference, emoji string,
	reactionID, eventID uuid.UUID,
	createdAt time.Time,
) (Reaction, Event, error) {
	return repository.addReaction(
		ctx,
		actorID,
		TargetIssue,
		issueReference,
		uuid.Nil,
		emoji,
		reactionID,
		eventID,
		createdAt,
	)
}

// AddCommentReaction inserts at most one actor/emoji row.
func (repository *Repository) AddCommentReaction(
	ctx context.Context,
	actorID, commentID uuid.UUID,
	emoji string,
	reactionID, eventID uuid.UUID,
	createdAt time.Time,
) (Reaction, Event, error) {
	return repository.addReaction(
		ctx,
		actorID,
		TargetComment,
		"",
		commentID,
		emoji,
		reactionID,
		eventID,
		createdAt,
	)
}

func (repository *Repository) addReaction(
	ctx context.Context,
	actorID uuid.UUID,
	kind TargetKind,
	issueReference string,
	commentID uuid.UUID,
	emoji string,
	reactionID, eventID uuid.UUID,
	createdAt time.Time,
) (Reaction, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Reaction{}, Event{}, errors.New("begin reaction creation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var (
		targetID    uuid.UUID
		workspaceID uuid.UUID
		boardID     uuid.UUID
		table       string
		targetField string
		permission  identity.Permission
	)
	switch kind {
	case TargetIssue:
		permission = identity.PermissionProductWrite
		access, err := authorizeIssueReference(
			ctx,
			tx,
			actorID,
			issueReference,
			permission,
			true,
		)
		if err != nil {
			return Reaction{}, Event{}, err
		}
		targetID, workspaceID, boardID = access.IssueID, access.WorkspaceID, access.BoardID
		table, targetField = "issue_reactions", "issue_id"
	case TargetComment:
		permission = identity.PermissionCommentWrite
		access, err := authorizeComment(ctx, tx, actorID, commentID, permission, true)
		if err != nil {
			return Reaction{}, Event{}, err
		}
		targetID, workspaceID, boardID = access.CommentID, access.WorkspaceID, access.BoardID
		table, targetField = "comment_reactions", "comment_id"
	default:
		return Reaction{}, Event{}, errors.New("invalid reaction target")
	}
	var actor Actor
	if err := tx.QueryRow(
		ctx,
		`SELECT user_account.id, user_account.name, user_account.avatar_url
		   FROM users AS user_account
		  WHERE user_account.id = $1`,
		actorID,
	).Scan(&actor.ID, &actor.Name, &actor.AvatarURL); err != nil {
		return Reaction{}, Event{}, classifyReadError("read reaction actor", err)
	}
	statement := fmt.Sprintf(
		`INSERT INTO %s (id, %s, actor_id, emoji, created_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (%s, actor_id, emoji) DO NOTHING
		 RETURNING id, created_at`,
		table,
		targetField,
		targetField,
	)
	var (
		storedID uuid.UUID
		storedAt time.Time
	)
	err = tx.QueryRow(
		ctx,
		statement,
		reactionID,
		targetID,
		actorID,
		emoji,
		createdAt.UTC(),
	).Scan(&storedID, &storedAt)
	created := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		query := fmt.Sprintf(
			`SELECT id, created_at FROM %s
			  WHERE %s = $1 AND actor_id = $2 AND emoji = $3`,
			table,
			targetField,
		)
		err = tx.QueryRow(ctx, query, targetID, actorID, emoji).Scan(&storedID, &storedAt)
	}
	if err != nil {
		return Reaction{}, Event{}, classifyWriteError("add reaction", err)
	}
	reaction := Reaction{
		ID:          storedID,
		WorkspaceID: workspaceID,
		TargetKind:  kind,
		TargetID:    targetID,
		Actor:       actor,
		Emoji:       emoji,
		CreatedAt:   storedAt.UTC(),
	}
	var event Event
	if created {
		event, err = makeEvent(
			eventID,
			workspaceID,
			boardID,
			string(kind)+".reaction.added",
			string(kind),
			targetID,
			reactionEventPayload(reaction),
			createdAt,
		)
		if err != nil {
			return Reaction{}, Event{}, err
		}
		if err := insertOutboxEvent(ctx, tx, event); err != nil {
			return Reaction{}, Event{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Reaction{}, Event{}, errors.New("commit reaction creation")
	}
	return reaction, event, nil
}

// RemoveIssueReaction removes only the authenticated actor's emoji.
func (repository *Repository) RemoveIssueReaction(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference, emoji string,
	eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	return repository.removeReaction(
		ctx,
		actorID,
		TargetIssue,
		issueReference,
		uuid.Nil,
		emoji,
		eventID,
		removedAt,
	)
}

// RemoveCommentReaction removes only the authenticated actor's emoji.
func (repository *Repository) RemoveCommentReaction(
	ctx context.Context,
	actorID, commentID uuid.UUID,
	emoji string,
	eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	return repository.removeReaction(
		ctx,
		actorID,
		TargetComment,
		"",
		commentID,
		emoji,
		eventID,
		removedAt,
	)
}

func (repository *Repository) removeReaction(
	ctx context.Context,
	actorID uuid.UUID,
	kind TargetKind,
	issueReference string,
	commentID uuid.UUID,
	emoji string,
	eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin reaction removal")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	var (
		targetID    uuid.UUID
		workspaceID uuid.UUID
		boardID     uuid.UUID
		table       string
		targetField string
	)
	switch kind {
	case TargetIssue:
		access, err := authorizeIssueReference(
			ctx,
			tx,
			actorID,
			issueReference,
			identity.PermissionProductWrite,
			true,
		)
		if err != nil {
			return Event{}, err
		}
		targetID, workspaceID, boardID = access.IssueID, access.WorkspaceID, access.BoardID
		table, targetField = "issue_reactions", "issue_id"
	case TargetComment:
		access, err := authorizeComment(
			ctx,
			tx,
			actorID,
			commentID,
			identity.PermissionCommentWrite,
			true,
		)
		if err != nil {
			return Event{}, err
		}
		targetID, workspaceID, boardID = access.CommentID, access.WorkspaceID, access.BoardID
		table, targetField = "comment_reactions", "comment_id"
	default:
		return Event{}, errors.New("invalid reaction target")
	}
	statement := fmt.Sprintf(
		`DELETE FROM %s
		  WHERE %s = $1 AND actor_id = $2 AND emoji = $3`,
		table,
		targetField,
	)
	tag, err := tx.Exec(ctx, statement, targetID, actorID, emoji)
	if err != nil {
		return Event{}, classifyWriteError("remove reaction", err)
	}
	var event Event
	if tag.RowsAffected() == 1 {
		event, err = makeEvent(
			eventID,
			workspaceID,
			boardID,
			string(kind)+".reaction.removed",
			string(kind),
			targetID,
			struct {
				TargetID uuid.UUID `json:"targetId"`
				ActorID  uuid.UUID `json:"actorId"`
				Emoji    string    `json:"emoji"`
			}{TargetID: targetID, ActorID: actorID, Emoji: emoji},
			removedAt,
		)
		if err != nil {
			return Event{}, err
		}
		if err := insertOutboxEvent(ctx, tx, event); err != nil {
			return Event{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, errors.New("commit reaction removal")
	}
	return event, nil
}

// ListIssueReactions returns one over-fetched stable page.
func (repository *Repository) ListIssueReactions(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	after *ReactionCursor,
	limit int,
) ([]Reaction, error) {
	access, err := authorizeIssueReference(
		ctx,
		repository.Pool,
		actorID,
		issueReference,
		identity.PermissionProductRead,
		false,
	)
	if err != nil {
		return nil, err
	}
	return repository.listReactions(
		ctx,
		TargetIssue,
		access.IssueID,
		access.WorkspaceID,
		after,
		limit,
	)
}

// ListCommentReactions returns one over-fetched stable page.
func (repository *Repository) ListCommentReactions(
	ctx context.Context,
	actorID, commentID uuid.UUID,
	after *ReactionCursor,
	limit int,
) ([]Reaction, error) {
	access, err := authorizeComment(
		ctx,
		repository.Pool,
		actorID,
		commentID,
		identity.PermissionProductRead,
		false,
	)
	if err != nil {
		return nil, err
	}
	return repository.listReactions(
		ctx,
		TargetComment,
		commentID,
		access.WorkspaceID,
		after,
		limit,
	)
}

func (repository *Repository) listReactions(
	ctx context.Context,
	kind TargetKind,
	targetID, workspaceID uuid.UUID,
	after *ReactionCursor,
	limit int,
) ([]Reaction, error) {
	if limit < 1 {
		return nil, errors.New("list reactions: invalid limit")
	}
	var table, targetField string
	switch kind {
	case TargetIssue:
		table, targetField = "issue_reactions", "issue_id"
	case TargetComment:
		table, targetField = "comment_reactions", "comment_id"
	default:
		return nil, errors.New("invalid reaction target")
	}
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime, afterID = after.CreatedAt, after.ID
	}
	statement := fmt.Sprintf(
		`SELECT reaction.id, reaction.actor_id, actor.name, actor.avatar_url,
		        reaction.emoji, reaction.created_at
		   FROM %s AS reaction
		   JOIN users AS actor ON actor.id = reaction.actor_id
		  WHERE reaction.%s = $1
		    AND (NOT $2::boolean OR
		        (reaction.created_at, reaction.id) >
		        ($3::timestamptz, $4::uuid))
		  ORDER BY reaction.created_at ASC, reaction.id ASC
		  LIMIT $5`,
		table,
		targetField,
	)
	rows, err := repository.Pool.Query(
		ctx,
		statement,
		targetID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list reactions")
	}
	defer rows.Close()
	result := make([]Reaction, 0, limit)
	for rows.Next() {
		reaction := Reaction{
			WorkspaceID: workspaceID,
			TargetKind:  kind,
			TargetID:    targetID,
		}
		if err := rows.Scan(
			&reaction.ID,
			&reaction.Actor.ID,
			&reaction.Actor.Name,
			&reaction.Actor.AvatarURL,
			&reaction.Emoji,
			&reaction.CreatedAt,
		); err != nil {
			return nil, errors.New("scan reaction")
		}
		result = append(result, reaction)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate reactions")
	}
	return result, nil
}

func reactionEventPayload(reaction Reaction) any {
	return struct {
		ReactionID uuid.UUID `json:"reactionId"`
		TargetID   uuid.UUID `json:"targetId"`
		ActorID    uuid.UUID `json:"actorId"`
		Emoji      string    `json:"emoji"`
	}{
		ReactionID: reaction.ID,
		TargetID:   reaction.TargetID,
		ActorID:    reaction.Actor.ID,
		Emoji:      reaction.Emoji,
	}
}
