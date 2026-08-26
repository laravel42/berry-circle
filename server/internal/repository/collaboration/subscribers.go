package collaboration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/laravel42/berry-circle/server/internal/identity"
)

// SubscribeSelf explicitly follows an issue for the authenticated user.
func (repository *Repository) SubscribeSelf(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	eventID uuid.UUID,
	createdAt time.Time,
) (Subscriber, Event, error) {
	return repository.addSubscriber(
		ctx,
		actorID,
		issueReference,
		actorID,
		identity.PermissionProductRead,
		eventID,
		createdAt,
	)
}

// AddSubscriber explicitly follows an issue for another active member. Only
// roles with members.manage can call this method.
func (repository *Repository) AddSubscriber(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	targetUserID, eventID uuid.UUID,
	createdAt time.Time,
) (Subscriber, Event, error) {
	return repository.addSubscriber(
		ctx,
		actorID,
		issueReference,
		targetUserID,
		identity.PermissionMembersManage,
		eventID,
		createdAt,
	)
}

func (repository *Repository) addSubscriber(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	targetUserID uuid.UUID,
	permission identity.Permission,
	eventID uuid.UUID,
	createdAt time.Time,
) (Subscriber, Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Subscriber{}, Event{}, errors.New("begin subscriber creation")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	access, err := authorizeIssueReference(
		ctx,
		tx,
		actorID,
		issueReference,
		permission,
		true,
	)
	if err != nil {
		return Subscriber{}, Event{}, err
	}
	var user Actor
	if err := tx.QueryRow(
		ctx,
		`SELECT user_account.id, user_account.name, user_account.avatar_url
		   FROM workspace_memberships AS membership
		   JOIN users AS user_account ON user_account.id = membership.user_id
		  WHERE membership.workspace_id = $1
		    AND membership.user_id = $2
		  FOR KEY SHARE OF membership, user_account`,
		access.WorkspaceID,
		targetUserID,
	).Scan(&user.ID, &user.Name, &user.AvatarURL); err != nil {
		return Subscriber{}, Event{}, classifyReadError("read subscriber member", err)
	}
	var storedAt time.Time
	err = tx.QueryRow(
		ctx,
		`INSERT INTO issue_subscribers (
		    workspace_id, issue_id, user_id, reason, created_at
		 ) VALUES ($1, $2, $3, 'manual', $4)
		 ON CONFLICT (issue_id, user_id) DO NOTHING
		 RETURNING created_at`,
		access.WorkspaceID,
		access.IssueID,
		targetUserID,
		createdAt.UTC(),
	).Scan(&storedAt)
	created := err == nil
	if errors.Is(err, pgx.ErrNoRows) {
		err = tx.QueryRow(
			ctx,
			`SELECT created_at
			   FROM issue_subscribers
			  WHERE workspace_id = $1 AND issue_id = $2 AND user_id = $3`,
			access.WorkspaceID,
			access.IssueID,
			targetUserID,
		).Scan(&storedAt)
	}
	if err != nil {
		return Subscriber{}, Event{}, classifyWriteError("add issue subscriber", err)
	}
	subscriber := Subscriber{
		WorkspaceID: access.WorkspaceID,
		IssueID:     access.IssueID,
		User:        user,
		Reason:      "manual",
		CreatedAt:   storedAt.UTC(),
	}
	var event Event
	if created {
		event, err = makeEvent(
			eventID,
			access.WorkspaceID,
			access.BoardID,
			"issue.subscriber.added",
			"issue",
			access.IssueID,
			subscriberEventPayload(subscriber),
			createdAt,
		)
		if err != nil {
			return Subscriber{}, Event{}, err
		}
		if err := insertOutboxEvent(ctx, tx, event); err != nil {
			return Subscriber{}, Event{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Subscriber{}, Event{}, errors.New("commit subscriber creation")
	}
	return subscriber, event, nil
}

// UnsubscribeSelf removes the authenticated user from one issue.
func (repository *Repository) UnsubscribeSelf(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	return repository.removeSubscriber(
		ctx,
		actorID,
		issueReference,
		actorID,
		identity.PermissionProductRead,
		eventID,
		removedAt,
	)
}

// RemoveSubscriber removes another member when the actor has members.manage.
func (repository *Repository) RemoveSubscriber(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	targetUserID, eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	return repository.removeSubscriber(
		ctx,
		actorID,
		issueReference,
		targetUserID,
		identity.PermissionMembersManage,
		eventID,
		removedAt,
	)
}

func (repository *Repository) removeSubscriber(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	targetUserID uuid.UUID,
	permission identity.Permission,
	eventID uuid.UUID,
	removedAt time.Time,
) (Event, error) {
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Event{}, errors.New("begin subscriber removal")
	}
	defer func() {
		_ = tx.Rollback(context.Background())
	}()
	access, err := authorizeIssueReference(
		ctx,
		tx,
		actorID,
		issueReference,
		permission,
		true,
	)
	if err != nil {
		return Event{}, err
	}
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM issue_subscribers
		  WHERE workspace_id = $1 AND issue_id = $2 AND user_id = $3`,
		access.WorkspaceID,
		access.IssueID,
		targetUserID,
	)
	if err != nil {
		return Event{}, classifyWriteError("remove issue subscriber", err)
	}
	var event Event
	if tag.RowsAffected() == 1 {
		event, err = makeEvent(
			eventID,
			access.WorkspaceID,
			access.BoardID,
			"issue.subscriber.removed",
			"issue",
			access.IssueID,
			struct {
				IssueID uuid.UUID `json:"issueId"`
				UserID  uuid.UUID `json:"userId"`
			}{IssueID: access.IssueID, UserID: targetUserID},
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
		return Event{}, errors.New("commit subscriber removal")
	}
	return event, nil
}

// ListSubscribers returns one over-fetched stable page of active members.
func (repository *Repository) ListSubscribers(
	ctx context.Context,
	actorID uuid.UUID,
	issueReference string,
	after *SubscriberCursor,
	limit int,
) ([]Subscriber, error) {
	if limit < 1 {
		return nil, errors.New("list subscribers: invalid limit")
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
	afterEnabled := after != nil
	var afterTime any
	var afterID any
	if after != nil {
		afterTime, afterID = after.CreatedAt, after.UserID
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT subscriber.user_id, user_account.name, user_account.avatar_url,
		        subscriber.reason, subscriber.created_at
		   FROM issue_subscribers AS subscriber
		   JOIN workspace_memberships AS membership
		     ON membership.workspace_id = subscriber.workspace_id
		    AND membership.user_id = subscriber.user_id
		   JOIN users AS user_account ON user_account.id = subscriber.user_id
		  WHERE subscriber.workspace_id = $1
		    AND subscriber.issue_id = $2
		    AND (NOT $3::boolean OR
		        (subscriber.created_at, subscriber.user_id) >
		        ($4::timestamptz, $5::uuid))
		  ORDER BY subscriber.created_at ASC, subscriber.user_id ASC
		  LIMIT $6`,
		access.WorkspaceID,
		access.IssueID,
		afterEnabled,
		afterTime,
		afterID,
		limit,
	)
	if err != nil {
		return nil, errors.New("list issue subscribers")
	}
	defer rows.Close()
	result := make([]Subscriber, 0, limit)
	for rows.Next() {
		subscriber := Subscriber{
			WorkspaceID: access.WorkspaceID,
			IssueID:     access.IssueID,
		}
		if err := rows.Scan(
			&subscriber.User.ID,
			&subscriber.User.Name,
			&subscriber.User.AvatarURL,
			&subscriber.Reason,
			&subscriber.CreatedAt,
		); err != nil {
			return nil, errors.New("scan issue subscriber")
		}
		result = append(result, subscriber)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("iterate issue subscribers")
	}
	return result, nil
}

func subscriberEventPayload(subscriber Subscriber) any {
	return struct {
		IssueID uuid.UUID `json:"issueId"`
		UserID  uuid.UUID `json:"userId"`
		Reason  string    `json:"reason"`
	}{
		IssueID: subscriber.IssueID,
		UserID:  subscriber.User.ID,
		Reason:  subscriber.Reason,
	}
}
