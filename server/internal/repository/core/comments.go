package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const commentProjection = `
	c.id, c.issue_id, c.body, c.author_type::text, c.author_id,
	COALESCE(author.name, author_agent.name),
	COALESCE(author.avatar_url, author_agent.avatar_url),
	c.parent_id, c.revision,
	c.resolved_at, c.resolved_by, resolver.name, resolver.avatar_url,
	c.created_at, c.updated_at`

// commentSource resolves a comment and both kinds of author.
//
// Agents author comments too — a run posts its result as one — and a users
// join alone renders those with a null name, as the literal word "Agent" and
// no avatar. One shared clause keeps the agent join from being forgotten at
// either read site.
const commentSource = `
	   FROM comments AS c
	   LEFT JOIN users AS author
	     ON c.author_type = 'user' AND author.id = c.author_id
	   LEFT JOIN agents AS author_agent
	     ON c.author_type = 'agent' AND author_agent.id = c.author_id
	   LEFT JOIN users AS resolver ON resolver.id = c.resolved_by`

// ListComments returns one over-fetched oldest-first stable page.
func (repository *Repository) ListComments(
	ctx context.Context,
	issueID uuid.UUID,
	after *CommentCursor,
	limit int,
) ([]Comment, error) {
	if limit < 1 {
		return nil, errors.New("list comments: invalid limit")
	}
	query := `SELECT ` + commentProjection + commentSource + `
		WHERE c.issue_id = $1`
	arguments := []any{issueID}
	if after != nil {
		query += ` AND (c.created_at, c.id) > ($2::timestamptz, $3::uuid)`
		arguments = append(arguments, after.CreatedAt, after.ID)
	}
	query += ` ORDER BY c.created_at ASC, c.id ASC LIMIT $` +
		fmt.Sprint(len(arguments)+1)
	arguments = append(arguments, limit)

	rows, err := repository.Pool.Query(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("list comments: %w", err)
	}
	defer rows.Close()

	comments := make([]Comment, 0, limit)
	for rows.Next() {
		comment, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		comments = append(comments, comment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate comments: %w", err)
	}
	return comments, nil
}

// GetComment returns one comment by immutable UUID.
func (repository *Repository) GetComment(
	ctx context.Context,
	id uuid.UUID,
) (Comment, error) {
	return getCommentByID(ctx, repository.Pool, id)
}

// CreateComment locks its issue and optional root parent before inserting.
func (repository *Repository) CreateComment(
	ctx context.Context,
	params CreateCommentParams,
	eventID uuid.UUID,
) (Comment, CommentMutationEvent, error) {
	authorType := params.AuthorType
	if authorType == "" {
		authorType = "user"
	}
	if authorType != "user" && authorType != "agent" {
		return Comment{}, CommentMutationEvent{}, fmt.Errorf(
			"create comment: unsupported author type %q", authorType)
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Comment{}, CommentMutationEvent{}, fmt.Errorf("begin comment creation: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var lockedIssue uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`SELECT id FROM issues WHERE id = $1 AND deleted_at IS NULL FOR KEY SHARE`,
		params.IssueID,
	).Scan(&lockedIssue); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Comment{}, CommentMutationEvent{}, ErrNotFound
		}
		return Comment{}, CommentMutationEvent{}, fmt.Errorf("lock comment issue: %w", err)
	}
	if params.ParentID != nil {
		var (
			parentIssueID uuid.UUID
			parentID      *uuid.UUID
		)
		if err := tx.QueryRow(
			ctx,
			`SELECT issue_id, parent_id FROM comments WHERE id = $1 FOR KEY SHARE`,
			*params.ParentID,
		).Scan(&parentIssueID, &parentID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return Comment{}, CommentMutationEvent{}, ErrNotFound
			}
			return Comment{}, CommentMutationEvent{}, fmt.Errorf("lock parent comment: %w", err)
		}
		if parentIssueID != params.IssueID {
			return Comment{}, CommentMutationEvent{}, ErrNotFound
		}
		if parentID != nil {
			return Comment{}, CommentMutationEvent{}, ErrInvalidParent
		}
	}

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO comments (
			id, issue_id, author_type, author_id, body, parent_id,
			created_at, updated_at
		 ) VALUES ($1, $2, $3::assignee_type, $4, $5, $6, $7, $7)`,
		params.ID,
		params.IssueID,
		authorType,
		params.AuthorID,
		params.Body,
		params.ParentID,
		params.CreatedAt,
	); err != nil {
		return Comment{}, CommentMutationEvent{}, classifyWriteError("create comment", err)
	}
	created, err := getCommentByID(ctx, tx, params.ID)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, err
	}
	event, err := persistCommentOutbox(
		ctx,
		tx,
		eventID,
		"comment.created",
		created,
		params.CreatedAt,
	)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Comment{}, CommentMutationEvent{}, fmt.Errorf("commit comment creation: %w", err)
	}
	return created, event, nil
}

// UpdateComment enforces author/admin ACL under the same row lock as the write.
func (repository *Repository) UpdateComment(
	ctx context.Context,
	id, actorID uuid.UUID,
	admin bool,
	body string,
	expectedRevision *int64,
	eventID uuid.UUID,
	updatedAt time.Time,
) (Comment, CommentMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Comment{}, CommentMutationEvent{}, fmt.Errorf("begin comment update: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	currentRevision, err := authorizeComment(ctx, tx, id, actorID, admin)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, err
	}
	if expectedRevision != nil && *expectedRevision != currentRevision {
		return Comment{}, CommentMutationEvent{}, &RevisionConflictError{
			CurrentRevision: currentRevision,
		}
	}
	tag, err := tx.Exec(
		ctx,
		`UPDATE comments
		    SET body = $2, revision = revision + 1, updated_at = $3
		  WHERE id = $1`,
		id,
		body,
		updatedAt,
	)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, classifyWriteError("update comment", err)
	}
	if tag.RowsAffected() != 1 {
		return Comment{}, CommentMutationEvent{}, ErrNotFound
	}
	updated, err := getCommentByID(ctx, tx, id)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, err
	}
	event, err := persistCommentOutbox(
		ctx,
		tx,
		eventID,
		"comment.updated",
		updated,
		updatedAt,
	)
	if err != nil {
		return Comment{}, CommentMutationEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Comment{}, CommentMutationEvent{}, fmt.Errorf("commit comment update: %w", err)
	}
	return updated, event, nil
}

// DeleteComment enforces author/admin ACL and relies on the parent FK cascade.
func (repository *Repository) DeleteComment(
	ctx context.Context,
	id, actorID uuid.UUID,
	admin bool,
	eventID uuid.UUID,
	deletedAt time.Time,
) (CommentMutationEvent, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return CommentMutationEvent{}, fmt.Errorf("begin comment deletion: %w", err)
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	if _, err := authorizeComment(ctx, tx, id, actorID, admin); err != nil {
		return CommentMutationEvent{}, err
	}
	existing, err := getCommentByID(ctx, tx, id)
	if err != nil {
		return CommentMutationEvent{}, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM comments WHERE id = $1`, id)
	if err != nil {
		return CommentMutationEvent{}, classifyWriteError("delete comment", err)
	}
	if tag.RowsAffected() != 1 {
		return CommentMutationEvent{}, ErrNotFound
	}
	event, err := persistCommentOutbox(
		ctx,
		tx,
		eventID,
		"comment.deleted",
		existing,
		deletedAt,
	)
	if err != nil {
		return CommentMutationEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return CommentMutationEvent{}, fmt.Errorf("commit comment deletion: %w", err)
	}
	return event, nil
}

func getCommentByID(
	ctx context.Context,
	queryer queryRower,
	id uuid.UUID,
) (Comment, error) {
	comment, err := scanComment(queryer.QueryRow(
		ctx,
		`SELECT `+commentProjection+commentSource+`
		  WHERE c.id = $1`,
		id,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return Comment{}, ErrNotFound
	}
	return comment, err
}

func scanComment(row rowScanner) (Comment, error) {
	var (
		comment        Comment
		authorType     string
		authorID       uuid.UUID
		authorName     *string
		authorAvatar   *string
		resolverID     *uuid.UUID
		resolverName   *string
		resolverAvatar *string
	)
	if err := row.Scan(
		&comment.ID,
		&comment.IssueID,
		&comment.Body,
		&authorType,
		&authorID,
		&authorName,
		&authorAvatar,
		&comment.ParentID,
		&comment.Revision,
		&comment.ResolvedAt,
		&resolverID,
		&resolverName,
		&resolverAvatar,
		&comment.CreatedAt,
		&comment.UpdatedAt,
	); err != nil {
		return Comment{}, err
	}
	comment.Author = *actorRef(authorType, authorID, authorName, authorAvatar)
	if resolverID != nil {
		comment.ResolvedBy = actorRef("user", *resolverID, resolverName, resolverAvatar)
	}
	return comment, nil
}

func authorizeComment(
	ctx context.Context,
	tx pgx.Tx,
	id, actorID uuid.UUID,
	admin bool,
) (int64, error) {
	var (
		authorType string
		authorID   uuid.UUID
		revision   int64
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT author_type::text, author_id, revision
		   FROM comments
		  WHERE id = $1
		  FOR UPDATE`,
		id,
	).Scan(&authorType, &authorID, &revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("lock comment: %w", err)
	}
	if !admin && (authorType != "user" || authorID != actorID) {
		return 0, ErrForbidden
	}
	return revision, nil
}

func persistCommentOutbox(
	ctx context.Context,
	tx pgx.Tx,
	eventID uuid.UUID,
	eventType string,
	comment Comment,
	occurredAt time.Time,
) (CommentMutationEvent, error) {
	if eventID == uuid.Nil {
		return CommentMutationEvent{}, errors.New("comment event ID is nil")
	}
	var workspaceID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`SELECT board.workspace_id
		   FROM issues AS issue
		   JOIN boards AS board ON board.id = issue.board_id
		  WHERE issue.id = $1 AND issue.deleted_at IS NULL`,
		comment.IssueID,
	).Scan(&workspaceID); err != nil {
		return CommentMutationEvent{}, fmt.Errorf("resolve comment event workspace: %w", err)
	}
	payload, err := json.Marshal(struct {
		Comment commentEventResource `json:"comment"`
	}{Comment: serializeCommentEvent(comment)})
	if err != nil {
		return CommentMutationEvent{}, errors.New("encode comment event payload")
	}
	event := CommentMutationEvent{
		ID:          eventID,
		WorkspaceID: workspaceID,
		Type:        eventType,
		Payload:     payload,
		OccurredAt:  occurredAt.UTC(),
	}
	envelope, err := json.Marshal(struct {
		ID            uuid.UUID       `json:"id"`
		Type          string          `json:"type"`
		OccurredAt    string          `json:"occurredAt"`
		WorkspaceID   uuid.UUID       `json:"workspaceId"`
		AggregateType string          `json:"aggregateType"`
		AggregateID   uuid.UUID       `json:"aggregateId"`
		Payload       json.RawMessage `json:"payload"`
	}{
		ID:            event.ID,
		Type:          event.Type,
		OccurredAt:    event.OccurredAt.Format(time.RFC3339Nano),
		WorkspaceID:   event.WorkspaceID,
		AggregateType: "comment",
		AggregateID:   comment.ID,
		Payload:       event.Payload,
	})
	if err != nil {
		return CommentMutationEvent{}, errors.New("encode comment outbox envelope")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO outbox_events (
		    id, topic, aggregate_type, aggregate_id, workspace_id,
		    payload, occurred_at, available_at
		 ) VALUES ($1, $2, 'comment', $3, $4, $5::jsonb, $6, $6)`,
		event.ID,
		event.Type,
		comment.ID,
		event.WorkspaceID,
		string(envelope),
		event.OccurredAt,
	); err != nil {
		return CommentMutationEvent{}, fmt.Errorf("persist comment outbox event: %w", err)
	}
	return event, nil
}

type commentEventResource struct {
	ID         uuid.UUID  `json:"id"`
	IssueID    uuid.UUID  `json:"issueId"`
	Body       string     `json:"body"`
	Author     ActorRef   `json:"author"`
	ParentID   *uuid.UUID `json:"parentId"`
	Revision   int64      `json:"revision"`
	ResolvedAt *string    `json:"resolvedAt"`
	ResolvedBy *ActorRef  `json:"resolvedBy"`
	CreatedAt  string     `json:"createdAt"`
	UpdatedAt  string     `json:"updatedAt"`
}

func serializeCommentEvent(comment Comment) commentEventResource {
	var resolvedAt *string
	if comment.ResolvedAt != nil {
		formatted := comment.ResolvedAt.UTC().Format(time.RFC3339Nano)
		resolvedAt = &formatted
	}
	return commentEventResource{
		ID:         comment.ID,
		IssueID:    comment.IssueID,
		Body:       comment.Body,
		Author:     comment.Author,
		ParentID:   comment.ParentID,
		Revision:   comment.Revision,
		ResolvedAt: resolvedAt,
		ResolvedBy: comment.ResolvedBy,
		CreatedAt:  comment.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:  comment.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}
