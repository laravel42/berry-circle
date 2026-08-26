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

const attachmentProjection = `
	attachment.id, board.workspace_id, board.id, attachment.issue_id, attachment.comment_id,
	COALESCE(attachment.uploader_type::text, 'user'),
	COALESCE(attachment.uploader_id, attachment.uploader_agent_id),
	attachment.uploader_name,
	COALESCE(uploader.avatar_url, uploader_agent.avatar_url),
	attachment.file_name, attachment.content_type, attachment.size_bytes,
	attachment.checksum_sha256, attachment.storage_key, attachment.state,
	attachment.created_at, attachment.ready_at, attachment.run_id`

// attachmentUploaderJoins resolves an uploader of either kind.
//
// Kept beside the projection because the two must agree: the projection reads a
// column from each table, so a query that selects it without joining both would
// fail, and one that joins only users would silently render every agent's
// output as unattributed.
const attachmentUploaderJoins = `
	   LEFT JOIN users AS uploader ON uploader.id = attachment.uploader_id
	   LEFT JOIN agents AS uploader_agent ON uploader_agent.id = attachment.uploader_agent_id`

// ReserveAttachment validates membership and association under locks, then
// inserts metadata in an invisible pending state.
func (repository *Repository) ReserveAttachment(
	ctx context.Context,
	params ReserveAttachmentParams,
) (Attachment, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Attachment{}, errors.New("begin attachment reservation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()

	var access issueAccess
	if params.IssueReference != "" {
		access, err = authorizeIssueReference(
			ctx,
			tx,
			params.UploaderID,
			params.IssueReference,
			identity.PermissionProductWrite,
			true,
		)
		if err != nil {
			return Attachment{}, err
		}
	}
	if params.CommentID != nil {
		comment, err := authorizeComment(
			ctx,
			tx,
			params.UploaderID,
			*params.CommentID,
			identity.PermissionCommentWrite,
			true,
		)
		if err != nil {
			return Attachment{}, err
		}
		if params.IssueReference == "" {
			access = issueAccess{
				IssueID:     comment.IssueID,
				WorkspaceID: comment.WorkspaceID,
				Role:        comment.Role,
			}
		} else if comment.IssueID != access.IssueID ||
			comment.WorkspaceID != access.WorkspaceID {
			return Attachment{}, ErrNotFound
		}
	}
	if access.IssueID == uuid.Nil {
		return Attachment{}, ErrNotFound
	}
	storageKey := fmt.Sprintf(
		"attachments/%s/%s",
		access.WorkspaceID,
		params.ID,
	)

	var (
		uploaderName   string
		uploaderAvatar *string
	)
	if err := tx.QueryRow(
		ctx,
		`SELECT user_account.name, user_account.avatar_url
		   FROM users AS user_account
		   JOIN workspace_memberships AS membership
		     ON membership.user_id = user_account.id
		    AND membership.workspace_id = $2
		  WHERE user_account.id = $1
		  FOR KEY SHARE OF user_account, membership`,
		params.UploaderID,
		access.WorkspaceID,
	).Scan(&uploaderName, &uploaderAvatar); err != nil {
		return Attachment{}, classifyReadError("read attachment uploader", err)
	}
	if _, err := tx.Exec(
		ctx,
		// uploader_type is written explicitly rather than defaulted: an
		// attachment with a null kind reads as unattributed, and this path is
		// the human upload. An agent-authored artifact sets 'agent' and
		// uploader_agent_id instead (ADR-0006).
		`INSERT INTO attachments (
		    id, issue_id, comment_id, uploader_type, uploader_id, uploader_name,
		    file_name, content_type, size_bytes, checksum_sha256,
		    storage_key, state, created_at
		 ) VALUES (
		    $1, $2, $3, 'user', $4, $5, $6, $7, $8, $9, $10, 'pending', $11
		 )`,
		params.ID,
		access.IssueID,
		params.CommentID,
		params.UploaderID,
		uploaderName,
		params.FileName,
		params.ContentType,
		params.SizeBytes,
		params.ChecksumSHA256[:],
		storageKey,
		params.CreatedAt.UTC(),
	); err != nil {
		return Attachment{}, classifyWriteError("reserve attachment", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Attachment{}, errors.New("commit attachment reservation")
	}
	return Attachment{
		ID:             params.ID,
		WorkspaceID:    access.WorkspaceID,
		IssueID:        access.IssueID,
		CommentID:      params.CommentID,
		Uploader:       &Actor{ID: params.UploaderID, Name: uploaderName, AvatarURL: uploaderAvatar},
		FileName:       params.FileName,
		ContentType:    params.ContentType,
		SizeBytes:      params.SizeBytes,
		ChecksumSHA256: params.ChecksumSHA256,
		StorageKey:     storageKey,
		State:          "pending",
		CreatedAt:      params.CreatedAt.UTC(),
	}, nil
}

// ActivateAttachment makes a successfully stored object visible and persists
// its outbox event in the same transaction.
func (repository *Repository) ActivateAttachment(
	ctx context.Context,
	actorID, attachmentID, eventID uuid.UUID,
	readyAt time.Time,
) (Attachment, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Attachment{}, Event{}, errors.New("begin attachment activation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	attachment, role, err := getAttachmentAuthorized(
		ctx,
		tx,
		actorID,
		attachmentID,
		identity.PermissionProductWrite,
		[]string{"pending", "ready"},
		true,
	)
	if err != nil {
		return Attachment{}, Event{}, err
	}
	if !canManageAttachment(actorID, role, attachment) {
		return Attachment{}, Event{}, ErrForbidden
	}
	if attachment.State == "ready" {
		if err := tx.Commit(ctx); err != nil {
			return Attachment{}, Event{}, errors.New("commit idempotent attachment activation")
		}
		return attachment, Event{}, nil
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE attachments
		    SET state = 'ready', ready_at = $2
		  WHERE id = $1 AND state = 'pending'`,
		attachmentID,
		readyAt.UTC(),
	); err != nil {
		return Attachment{}, Event{}, classifyWriteError("activate attachment", err)
	}
	readyAtUTC := readyAt.UTC()
	attachment.State = "ready"
	attachment.ReadyAt = &readyAtUTC
	event, err := makeEvent(
		eventID,
		attachment.WorkspaceID,
		attachment.BoardID,
		"attachment.created",
		"attachment",
		attachment.ID,
		attachmentEventPayload(attachment),
		readyAt,
	)
	if err != nil {
		return Attachment{}, Event{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return Attachment{}, Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Attachment{}, Event{}, errors.New("commit attachment activation")
	}
	return attachment, event, nil
}

// AbortAttachment removes an invisible reservation after object-storage failure.
func (repository *Repository) AbortAttachment(
	ctx context.Context,
	actorID, attachmentID uuid.UUID,
) error {
	if _, err := repository.Pool.Exec(
		ctx,
		`DELETE FROM attachments
		  WHERE id = $1 AND uploader_id = $2 AND state = 'pending'`,
		attachmentID,
		actorID,
	); err != nil {
		return errors.New("abort attachment reservation")
	}
	return nil
}

// GetAttachment returns only ready metadata after a hidden membership check.
func (repository *Repository) GetAttachment(
	ctx context.Context,
	actorID, attachmentID uuid.UUID,
) (Attachment, error) {
	attachment, _, err := getAttachmentAuthorized(
		ctx,
		repository.Pool,
		actorID,
		attachmentID,
		identity.PermissionProductRead,
		[]string{"ready"},
		false,
	)
	return attachment, err
}

// ListIssueAttachments returns one over-fetched stable page. An optional
// comment filter must belong to the same authorized issue.
func (repository *Repository) ListIssueAttachments(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	commentID *uuid.UUID,
	after *AttachmentCursor,
	limit int,
) ([]Attachment, error) {
	if limit < 1 {
		return nil, errors.New("list attachments: invalid limit")
	}
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
	if commentID != nil {
		comment, err := authorizeComment(
			ctx,
			repository.Pool,
			actorID,
			*commentID,
			identity.PermissionProductRead,
			false,
		)
		if err != nil {
			return nil, err
		}
		if comment.IssueID != access.IssueID {
			return nil, ErrNotFound
		}
	}
	return repository.listAttachments(ctx, access.IssueID, commentID, after, limit)
}

// ListCommentAttachments returns one over-fetched stable comment page.
func (repository *Repository) ListCommentAttachments(
	ctx context.Context,
	actorID, commentID uuid.UUID,
	after *AttachmentCursor,
	limit int,
) ([]Attachment, error) {
	if limit < 1 {
		return nil, errors.New("list attachments: invalid limit")
	}
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
	return repository.listAttachments(ctx, access.IssueID, &commentID, after, limit)
}

func (repository *Repository) listAttachments(
	ctx context.Context,
	issueID uuid.UUID,
	commentID *uuid.UUID,
	after *AttachmentCursor,
	limit int,
) ([]Attachment, error) {
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime = after.CreatedAt
		afterID = after.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+attachmentProjection+`
		   FROM attachments AS attachment
		   JOIN issues AS issue ON issue.id = attachment.issue_id
		   JOIN boards AS board ON board.id = issue.board_id
`+attachmentUploaderJoins+`
		  WHERE attachment.issue_id = $1
		    AND attachment.state = 'ready'
		    AND ($2::uuid IS NULL OR attachment.comment_id = $2)
		    AND (NOT $3::boolean OR
		        (attachment.created_at, attachment.id) >
		        ($4::timestamptz, $5::uuid))
		  ORDER BY attachment.created_at ASC, attachment.id ASC
		  LIMIT $6`,
		issueID,
		commentID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list attachment metadata")
	}
	defer rows.Close()
	result := make([]Attachment, 0, limit)
	for rows.Next() {
		attachment, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate attachment metadata")
	}
	return result, nil
}

// BeginAttachmentDelete hides metadata before object deletion. A failed storage
// delete can safely restore the row with CancelAttachmentDelete.
func (repository *Repository) BeginAttachmentDelete(
	ctx context.Context,
	actorID, attachmentID uuid.UUID,
) (Attachment, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Attachment{}, errors.New("begin attachment deletion")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	attachment, role, err := getAttachmentAuthorized(
		ctx,
		tx,
		actorID,
		attachmentID,
		identity.PermissionProductWrite,
		[]string{"ready", "deleting"},
		true,
	)
	if err != nil {
		return Attachment{}, err
	}
	if !canManageAttachment(actorID, role, attachment) {
		return Attachment{}, ErrForbidden
	}
	if attachment.State == "ready" {
		if _, err := tx.Exec(
			ctx,
			`UPDATE attachments SET state = 'deleting'
			  WHERE id = $1 AND state = 'ready'`,
			attachmentID,
		); err != nil {
			return Attachment{}, classifyWriteError("mark attachment deleting", err)
		}
		attachment.State = "deleting"
	}
	if err := tx.Commit(ctx); err != nil {
		return Attachment{}, errors.New("commit attachment deletion start")
	}
	return attachment, nil
}

// CancelAttachmentDelete restores metadata after object deletion failed.
func (repository *Repository) CancelAttachmentDelete(
	ctx context.Context,
	actorID, attachmentID uuid.UUID,
) error {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return errors.New("begin attachment deletion cancellation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	attachment, role, err := getAttachmentAuthorized(
		ctx,
		tx,
		actorID,
		attachmentID,
		identity.PermissionProductWrite,
		[]string{"deleting"},
		true,
	)
	if err != nil {
		return err
	}
	if !canManageAttachment(actorID, role, attachment) {
		return ErrForbidden
	}
	tag, err := tx.Exec(
		ctx,
		`UPDATE attachments SET state = 'ready'
		  WHERE id = $1 AND state = 'deleting'`,
		attachmentID,
	)
	if err != nil {
		return classifyWriteError("restore attachment after storage failure", err)
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit attachment deletion cancellation")
	}
	return nil
}

// CompleteAttachmentDelete removes hidden metadata and records the durable
// deletion event after the backend object is gone.
func (repository *Repository) CompleteAttachmentDelete(
	ctx context.Context,
	actorID, attachmentID, eventID uuid.UUID,
	deletedAt time.Time,
) (Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin attachment deletion completion")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	attachment, role, err := getAttachmentAuthorized(
		ctx,
		tx,
		actorID,
		attachmentID,
		identity.PermissionProductWrite,
		[]string{"deleting"},
		true,
	)
	if err != nil {
		return Event{}, err
	}
	if !canManageAttachment(actorID, role, attachment) {
		return Event{}, ErrForbidden
	}
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM attachments WHERE id = $1 AND state = 'deleting'`,
		attachmentID,
	)
	if err != nil {
		return Event{}, classifyWriteError("delete attachment metadata", err)
	}
	if tag.RowsAffected() != 1 {
		return Event{}, ErrNotFound
	}
	event, err := makeEvent(
		eventID,
		attachment.WorkspaceID,
		attachment.BoardID,
		"attachment.deleted",
		"attachment",
		attachment.ID,
		attachmentEventPayload(attachment),
		deletedAt,
	)
	if err != nil {
		return Event{}, err
	}
	if err := insertOutboxEvent(ctx, tx, event); err != nil {
		return Event{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Event{}, errors.New("commit attachment deletion completion")
	}
	return event, nil
}

func getAttachmentAuthorized(
	ctx context.Context,
	queryer database,
	actorID, attachmentID uuid.UUID,
	permission identity.Permission,
	states []string,
	lock bool,
) (Attachment, identity.Role, error) {
	statement := `SELECT ` + attachmentProjection + `, membership.role::text
		FROM attachments AS attachment
		JOIN issues AS issue ON issue.id = attachment.issue_id
		JOIN boards AS board ON board.id = issue.board_id
		JOIN workspaces AS workspace
		  ON workspace.id = board.workspace_id
		 AND workspace.deleted_at IS NULL
		JOIN workspace_memberships AS membership
		  ON membership.workspace_id = workspace.id
		 AND membership.user_id = $2
` + attachmentUploaderJoins + `
		WHERE attachment.id = $1 AND attachment.state = ANY($3::text[])`
	if lock {
		statement += ` FOR UPDATE OF attachment`
		statement += ` FOR KEY SHARE OF issue, board, workspace, membership`
	}
	var role string
	attachment, err := scanAttachmentWithRole(
		queryer.QueryRow(ctx, statement, attachmentID, actorID, states),
		&role,
	)
	if err != nil {
		return Attachment{}, "", classifyReadError("read attachment metadata", err)
	}
	workspaceRole := identity.Role(role)
	if !workspaceRole.Allows(permission) {
		return Attachment{}, "", ErrForbidden
	}
	return attachment, workspaceRole, nil
}

func scanAttachment(row pgx.Row) (Attachment, error) {
	return scanAttachmentFields(row, nil)
}

func scanAttachmentWithRole(row pgx.Row, role *string) (Attachment, error) {
	return scanAttachmentFields(row, role)
}

func scanAttachmentFields(row pgx.Row, role *string) (Attachment, error) {
	var (
		attachment Attachment
		uploaderID *uuid.UUID
		name       string
		avatar     *string
		checksum   []byte
	)
	targets := []any{
		&attachment.ID,
		&attachment.WorkspaceID,
		&attachment.BoardID,
		&attachment.IssueID,
		&attachment.CommentID,
		&attachment.UploaderType,
		&uploaderID,
		&name,
		&avatar,
		&attachment.FileName,
		&attachment.ContentType,
		&attachment.SizeBytes,
		&checksum,
		&attachment.StorageKey,
		&attachment.State,
		&attachment.CreatedAt,
		&attachment.ReadyAt,
		&attachment.RunID,
	}
	if role != nil {
		targets = append(targets, role)
	}
	if err := row.Scan(targets...); err != nil {
		return Attachment{}, err
	}
	if len(checksum) != len(attachment.ChecksumSHA256) {
		return Attachment{}, errors.New("attachment checksum metadata is invalid")
	}
	copy(attachment.ChecksumSHA256[:], checksum)
	if uploaderID != nil {
		attachment.Uploader = &Actor{ID: *uploaderID, Name: name, AvatarURL: avatar}
	}
	return attachment, nil
}

func canManageAttachment(
	actorID uuid.UUID,
	role identity.Role,
	attachment Attachment,
) bool {
	if role == identity.RoleOwner || role == identity.RoleAdmin {
		return true
	}
	return attachment.Uploader != nil && attachment.Uploader.ID == actorID
}

func attachmentEventPayload(attachment Attachment) any {
	return struct {
		AttachmentID uuid.UUID  `json:"attachmentId"`
		IssueID      uuid.UUID  `json:"issueId"`
		CommentID    *uuid.UUID `json:"commentId"`
		FileName     string     `json:"fileName"`
		ContentType  string     `json:"contentType"`
		SizeBytes    int64      `json:"sizeBytes"`
	}{
		AttachmentID: attachment.ID,
		IssueID:      attachment.IssueID,
		CommentID:    attachment.CommentID,
		FileName:     attachment.FileName,
		ContentType:  attachment.ContentType,
		SizeBytes:    attachment.SizeBytes,
	}
}

func attachmentOperationError(operation string, err error) error {
	return fmt.Errorf("%s: %w", operation, err)
}
