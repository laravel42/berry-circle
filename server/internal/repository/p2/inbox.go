package p2

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

const inboxProjection = `
	inbox.id, inbox.workspace_id, inbox.recipient_id, inbox.source_event_id,
	inbox.event_type, inbox.category, inbox.severity, inbox.issue_id,
	issue.status::text, inbox.actor_type, inbox.actor_id, inbox.title, inbox.body,
	inbox.details, inbox.read_at, inbox.archived_at, inbox.created_at`

func (repository *Repository) ListInbox(
	ctx context.Context,
	workspaceID, recipientID uuid.UUID,
	filter InboxFilter,
) ([]InboxItem, error) {
	if filter.Limit < 1 || filter.Limit > 101 {
		return nil, errors.New("list inbox: invalid limit")
	}
	if filter.State != "active" && filter.State != "archived" && filter.State != "all" {
		return nil, errors.New("list inbox: invalid state")
	}
	afterEnabled := filter.After != nil
	var afterTime, afterID any
	if filter.After != nil {
		afterTime, afterID = filter.After.CreatedAt, filter.After.ID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT `+inboxProjection+`
		   FROM inbox_items AS inbox
		   LEFT JOIN issues AS issue ON issue.id = inbox.issue_id
		  WHERE inbox.workspace_id = $1
		    AND inbox.recipient_id = $2
		    AND (
		        $3::text = 'all'
		        OR ($3::text = 'active' AND inbox.archived_at IS NULL)
		        OR ($3::text = 'archived' AND inbox.archived_at IS NOT NULL)
		    )
		    AND (NOT $4::boolean OR inbox.read_at IS NULL)
		    AND (NOT $5::boolean OR
		        (inbox.created_at, inbox.id) < ($6::timestamptz, $7::uuid))
		  ORDER BY inbox.created_at DESC, inbox.id DESC
		  LIMIT $8`,
		workspaceID,
		recipientID,
		filter.State,
		filter.UnreadOnly,
		afterEnabled,
		afterTime,
		afterID,
		filter.Limit,
	)
	if err != nil {
		return nil, errors.New("list inbox")
	}
	defer rows.Close()
	result := make([]InboxItem, 0, filter.Limit)
	for rows.Next() {
		item, err := scanInboxItem(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate inbox")
	}
	return result, nil
}

func (repository *Repository) CountUnreadInbox(
	ctx context.Context,
	workspaceID, recipientID uuid.UUID,
) (int64, error) {
	var count int64
	if err := repository.Pool.QueryRow(
		ctx,
		`SELECT count(*) FROM inbox_items
		  WHERE workspace_id = $1 AND recipient_id = $2
		    AND read_at IS NULL AND archived_at IS NULL`,
		workspaceID,
		recipientID,
	).Scan(&count); err != nil {
		return 0, errors.New("count unread inbox")
	}
	return count, nil
}

func (repository *Repository) UpdateInboxItem(
	ctx context.Context,
	workspaceID, recipientID, itemID uuid.UUID,
	action string,
	now time.Time,
) (InboxItem, error) {
	setClause, usesTimestamp, err := inboxActionSet(action)
	if err != nil {
		return InboxItem{}, err
	}
	args := []any{itemID, workspaceID, recipientID}
	if usesTimestamp {
		args = append(args, now)
	}
	tag, err := repository.Pool.Exec(
		ctx,
		`UPDATE inbox_items SET `+setClause+`
		  WHERE id = $1 AND workspace_id = $2 AND recipient_id = $3`,
		args...,
	)
	if err != nil {
		return InboxItem{}, fmt.Errorf("update inbox item: %w", err)
	}
	if tag.RowsAffected() != 1 {
		return InboxItem{}, ErrNotFound
	}
	item, err := scanInboxItem(repository.Pool.QueryRow(
		ctx,
		`SELECT `+inboxProjection+`
		   FROM inbox_items AS inbox
		   LEFT JOIN issues AS issue ON issue.id = inbox.issue_id
		  WHERE inbox.id = $1 AND inbox.workspace_id = $2
		    AND inbox.recipient_id = $3`,
		itemID,
		workspaceID,
		recipientID,
	))
	if err != nil {
		return InboxItem{}, errors.New("read updated inbox item")
	}
	return item, nil
}

func (repository *Repository) BulkUpdateInbox(
	ctx context.Context,
	workspaceID, recipientID uuid.UUID,
	ids []uuid.UUID,
	action string,
	now time.Time,
) ([]uuid.UUID, error) {
	setClause, usesTimestamp, err := inboxActionSet(action)
	if err != nil {
		return nil, err
	}
	args := []any{workspaceID, recipientID, ids}
	if usesTimestamp {
		args = append(args, now)
	}
	rows, err := repository.Pool.Query(
		ctx,
		`UPDATE inbox_items SET `+setClause+`
		  WHERE workspace_id = $1 AND recipient_id = $2 AND id = ANY($3::uuid[])
		  RETURNING id`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("bulk update inbox: %w", err)
	}
	defer rows.Close()
	updated := make([]uuid.UUID, 0, len(ids))
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, errors.New("scan bulk inbox result")
		}
		updated = append(updated, id)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate bulk inbox result")
	}
	return updated, nil
}

func inboxActionSet(action string) (string, bool, error) {
	switch action {
	case "read":
		return "read_at = COALESCE(read_at, $4)", true, nil
	case "unread":
		return "read_at = NULL", false, nil
	case "archive":
		return "archived_at = COALESCE(archived_at, $4)", true, nil
	case "unarchive":
		return "archived_at = NULL", false, nil
	default:
		return "", false, errors.New("invalid inbox action")
	}
}

func scanInboxItem(row scanner) (InboxItem, error) {
	var (
		item    InboxItem
		details []byte
	)
	if err := row.Scan(
		&item.ID,
		&item.WorkspaceID,
		&item.RecipientID,
		&item.SourceEventID,
		&item.EventType,
		&item.Category,
		&item.Severity,
		&item.IssueID,
		&item.IssueStatus,
		&item.ActorType,
		&item.ActorID,
		&item.Title,
		&item.Body,
		&details,
		&item.ReadAt,
		&item.ArchivedAt,
		&item.CreatedAt,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return InboxItem{}, ErrNotFound
		}
		return InboxItem{}, errors.New("scan inbox item")
	}
	item.Details = append(json.RawMessage(nil), details...)
	return item, nil
}
