// Package conversations owns Berry-side threads, participants, and messages.
//
// Berry is authoritative here; Infobip is transport. A message that arrived
// over WhatsApp and one typed in the app are the same kind of row, differing
// only by provenance — which is what lets one brief start on a phone and
// continue at a desk.
package conversations

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Repository owns the hand-written pgx boundary for conversations.
type Repository struct {
	Pool *pgxpool.Pool
}

// New validates the authoritative PostgreSQL dependency.
func New(pool *pgxpool.Pool) (*Repository, error) {
	if pool == nil {
		return nil, errors.New("conversation repository pool is nil")
	}
	return &Repository{Pool: pool}, nil
}

var (
	// ErrUnknownSender means no verified identity owns the inbound address.
	// Deliberately distinct from a generic failure: it is the expected outcome
	// for a stranger messaging the business number, not a fault.
	ErrUnknownSender = errors.New("no verified user owns this address")
	ErrDuplicate     = errors.New("message already recorded")
	ErrAgentNotFound = errors.New("agent not found in this workspace")
)

// Sender is the Berry identity behind an inbound address.
type Sender struct {
	UserID      uuid.UUID
	WorkspaceID uuid.UUID
	DisplayName string
}

// ResolveSender maps an inbound channel address to a Berry user.
//
// Only verified identities resolve. An unverified address is treated as
// unknown, because attributing an inbound message to a user on the strength of
// an unproven phone number would let anyone speak as them — and in this product
// speaking as someone means approving plans.
//
// The workspace comes from the user's membership rather than the message,
// because the provider has no concept of a Berry workspace.
func (repository *Repository) ResolveSender(
	ctx context.Context,
	channel, address string,
) (Sender, error) {
	channel, address = strings.TrimSpace(channel), strings.TrimSpace(address)
	if channel == "" || address == "" {
		return Sender{}, ErrUnknownSender
	}
	var sender Sender
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT identity.user_id, membership.workspace_id, users.name
		   FROM user_channel_identities AS identity
		   JOIN users ON users.id = identity.user_id
		   JOIN workspace_memberships AS membership
		     ON membership.user_id = identity.user_id
		  WHERE identity.channel = $1
		    AND lower(identity.address) = lower($2)
		    AND identity.verified_at IS NOT NULL
		  ORDER BY membership.created_at ASC
		  LIMIT 1`,
		channel, address,
	).Scan(&sender.UserID, &sender.WorkspaceID, &sender.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return Sender{}, ErrUnknownSender
	}
	if err != nil {
		return Sender{}, errors.New("resolve inbound sender")
	}
	return sender, nil
}

// InboundMessage is one message received from a channel provider.
type InboundMessage struct {
	Channel    string
	Address    string
	Body       string
	ExternalID string
	ReceivedAt time.Time
}

// Recorded reports where an inbound message landed.
type Recorded struct {
	ConversationID uuid.UUID
	MessageID      uuid.UUID
	UserID         uuid.UUID
	WorkspaceID    uuid.UUID
	Created        bool
}

// RecordInbound attributes an inbound message to a Berry user and appends it to
// their open brief, opening one if none exists.
//
// Idempotent on (channel, external_id): providers retry webhooks, and a repeat
// must not post the user's message twice. A duplicate returns the original
// placement with Created false rather than an error, so the caller can still
// answer 200 and stop the provider retrying forever.
func (repository *Repository) RecordInbound(
	ctx context.Context,
	message InboundMessage,
	now time.Time,
) (Recorded, error) {
	if strings.TrimSpace(message.Body) == "" || strings.TrimSpace(message.ExternalID) == "" {
		return Recorded{}, errors.New("inbound message body and provider id are required")
	}
	sender, err := repository.ResolveSender(ctx, message.Channel, message.Address)
	if err != nil {
		return Recorded{}, err
	}

	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return Recorded{}, errors.New("begin inbound record")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	// Duplicate check first: a retried webhook must not open a second thread
	// before failing on the message insert.
	var existing Recorded
	err = tx.QueryRow(
		ctx,
		`SELECT id, conversation_id FROM conversation_messages
		  WHERE channel = $1 AND external_id = $2`,
		message.Channel, message.ExternalID,
	).Scan(&existing.MessageID, &existing.ConversationID)
	if err == nil {
		existing.UserID, existing.WorkspaceID = sender.UserID, sender.WorkspaceID
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return Recorded{}, errors.New("check inbound duplicate")
	}

	conversationID, err := openBrief(ctx, tx, sender, now)
	if err != nil {
		return Recorded{}, err
	}

	var messageID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO conversation_messages (
		    conversation_id, author_type, author_id, body,
		    channel, direction, external_id, created_at
		 ) VALUES ($1, 'user', $2, $3, $4, 'inbound', $5, $6)
		 RETURNING id`,
		conversationID, sender.UserID, message.Body,
		message.Channel, message.ExternalID, now,
	).Scan(&messageID); err != nil {
		return Recorded{}, errors.New("record inbound message")
	}

	if _, err := tx.Exec(
		ctx,
		`UPDATE conversations SET updated_at = $2 WHERE id = $1`,
		conversationID, now,
	); err != nil {
		return Recorded{}, errors.New("touch conversation")
	}
	if err := tx.Commit(ctx); err != nil {
		return Recorded{}, errors.New("commit inbound record")
	}
	return Recorded{
		ConversationID: conversationID,
		MessageID:      messageID,
		UserID:         sender.UserID,
		WorkspaceID:    sender.WorkspaceID,
		Created:        true,
	}, nil
}

// openBrief finds the sender's open brief or starts one.
//
// A person messaging from their phone is continuing a conversation, not
// starting a new one each time, so an existing open brief is reused. The
// orchestrator is added as a participant at creation because a brief with no
// agent in it has nobody to answer.
func openBrief(
	ctx context.Context,
	tx pgx.Tx,
	sender Sender,
	now time.Time,
) (uuid.UUID, error) {
	var conversationID uuid.UUID
	err := tx.QueryRow(
		ctx,
		`SELECT conversation.id
		   FROM conversations AS conversation
		   JOIN conversation_participants AS participant
		     ON participant.conversation_id = conversation.id
		    AND participant.participant_type = 'user'
		    AND participant.participant_id = $1
		    AND participant.left_at IS NULL
		  WHERE conversation.workspace_id = $2
		    AND conversation.kind = 'brief'
		    AND conversation.status = 'open'
		  ORDER BY conversation.updated_at DESC
		  LIMIT 1`,
		sender.UserID, sender.WorkspaceID,
	).Scan(&conversationID)
	if err == nil {
		return conversationID, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("find open brief")
	}

	if err := tx.QueryRow(
		ctx,
		`INSERT INTO conversations (
		    workspace_id, kind, topic, status, created_by, created_at, updated_at
		 ) VALUES ($1, 'brief', $2, 'open', $3, $4, $4)
		 RETURNING id`,
		sender.WorkspaceID, "Brief", sender.UserID, now,
	).Scan(&conversationID); err != nil {
		return uuid.Nil, errors.New("open brief conversation")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO conversation_participants
		    (conversation_id, participant_type, participant_id, role, joined_at)
		 VALUES ($1, 'user', $2, 'owner', $3)`,
		conversationID, sender.UserID, now,
	); err != nil {
		return uuid.Nil, errors.New("add brief owner")
	}
	// Best effort: a workspace always has an orchestrator (migration 009), but
	// a missing one must not lose the user's message.
	_, _ = tx.Exec(
		ctx,
		`INSERT INTO conversation_participants
		    (conversation_id, participant_type, participant_id, role, joined_at)
		 SELECT $1, 'agent', agents.id, 'member', $3
		   FROM agents
		  WHERE agents.workspace_id = $2 AND agents.protected
		  LIMIT 1`,
		conversationID, sender.WorkspaceID, now,
	)
	return conversationID, nil
}

// Summary is one thread in the sidebar list.
type Summary struct {
	ID           uuid.UUID
	Kind         string
	Topic        string
	Status       string
	AgentID      *uuid.UUID
	AgentName    *string
	MessageCount int
	UpdatedAt    time.Time
}

// Message is one persisted turn in a thread.
type Message struct {
	ID         uuid.UUID
	AuthorType string
	AuthorID   *uuid.UUID
	AuthorName string
	Body       string
	Channel    string
	CreatedAt  time.Time
}

// List returns the workspace's open threads, most recently active first.
//
// The agent is joined in because the sidebar renders a thread by who is in it,
// not by its topic — an unnamed direct thread is identified by its agent.
func (repository *Repository) List(
	ctx context.Context,
	workspaceID uuid.UUID,
	limit int,
) ([]Summary, error) {
	if repository == nil || repository.Pool == nil || workspaceID == uuid.Nil {
		return nil, errors.New("conversation list scope is invalid")
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT conversation.id, conversation.kind, COALESCE(conversation.topic, ''),
		        conversation.status, agent.id, agent.name,
		        (SELECT count(*) FROM conversation_messages message
		          WHERE message.conversation_id = conversation.id),
		        conversation.updated_at
		   FROM conversations AS conversation
		   LEFT JOIN conversation_participants AS participant
		     ON participant.conversation_id = conversation.id
		    AND participant.participant_type = 'agent'
		    AND participant.left_at IS NULL
		   LEFT JOIN agents AS agent ON agent.id = participant.participant_id
		  WHERE conversation.workspace_id = $1 AND conversation.status = 'open'
		  ORDER BY conversation.updated_at DESC, conversation.id
		  LIMIT $2`,
		workspaceID, limit,
	)
	if err != nil {
		return nil, errors.New("list conversations")
	}
	defer rows.Close()

	summaries := make([]Summary, 0, limit)
	for rows.Next() {
		var summary Summary
		var count int64
		if err := rows.Scan(
			&summary.ID, &summary.Kind, &summary.Topic, &summary.Status,
			&summary.AgentID, &summary.AgentName, &count, &summary.UpdatedAt,
		); err != nil {
			return nil, errors.New("scan conversation")
		}
		summary.MessageCount = int(count)
		summaries = append(summaries, summary)
	}
	if rows.Err() != nil {
		return nil, errors.New("read conversations")
	}
	return summaries, nil
}

// Messages returns a thread's turns in arrival order.
//
// Author names are resolved here rather than in the client: a message outlives
// the agent or user that wrote it, and the thread should still say who spoke.
func (repository *Repository) Messages(
	ctx context.Context,
	workspaceID, conversationID uuid.UUID,
	limit int,
) ([]Message, error) {
	if repository == nil || repository.Pool == nil {
		return nil, errors.New("conversation message scope is invalid")
	}
	if limit < 1 || limit > 500 {
		limit = 200
	}
	rows, err := repository.Pool.Query(
		ctx,
		`SELECT message.id, message.author_type, message.author_id,
		        COALESCE(users.name, agents.name, 'Berry'),
		        message.body, message.channel, message.created_at
		   FROM conversation_messages AS message
		   JOIN conversations AS conversation
		     ON conversation.id = message.conversation_id
		    AND conversation.workspace_id = $1
		   LEFT JOIN users ON message.author_type = 'user' AND users.id = message.author_id
		   LEFT JOIN agents ON message.author_type = 'agent' AND agents.id = message.author_id
		  WHERE message.conversation_id = $2
		  ORDER BY message.created_at, message.id
		  LIMIT $3`,
		workspaceID, conversationID, limit,
	)
	if err != nil {
		return nil, errors.New("list conversation messages")
	}
	defer rows.Close()

	messages := make([]Message, 0, limit)
	for rows.Next() {
		var message Message
		if err := rows.Scan(
			&message.ID, &message.AuthorType, &message.AuthorID,
			&message.AuthorName, &message.Body, &message.Channel, &message.CreatedAt,
		); err != nil {
			return nil, errors.New("scan conversation message")
		}
		messages = append(messages, message)
	}
	if rows.Err() != nil {
		return nil, errors.New("read conversation messages")
	}
	return messages, nil
}

// EnsureAgentThread finds the user's open thread with an agent, or opens one.
//
// Reused rather than recreated per message, so a conversation with an agent
// accumulates history the way a chat should. The agent must belong to the
// workspace: an agent id is not a capability, and taking it on trust would let
// a caller start a thread with any agent in the deployment.
func (repository *Repository) EnsureAgentThread(
	ctx context.Context,
	workspaceID, userID, agentID uuid.UUID,
	now time.Time,
) (uuid.UUID, error) {
	if workspaceID == uuid.Nil || userID == uuid.Nil || agentID == uuid.Nil {
		return uuid.Nil, errors.New("agent thread scope is invalid")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return uuid.Nil, errors.New("begin agent thread")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var agentName string
	if err := tx.QueryRow(
		ctx,
		`SELECT name FROM agents
		  WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
		agentID, workspaceID,
	).Scan(&agentName); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrAgentNotFound
	} else if err != nil {
		return uuid.Nil, errors.New("resolve thread agent")
	}

	var conversationID uuid.UUID
	err = tx.QueryRow(
		ctx,
		`SELECT conversation.id
		   FROM conversations AS conversation
		   JOIN conversation_participants AS agent
		     ON agent.conversation_id = conversation.id
		    AND agent.participant_type = 'agent' AND agent.participant_id = $3
		    AND agent.left_at IS NULL
		   JOIN conversation_participants AS member
		     ON member.conversation_id = conversation.id
		    AND member.participant_type = 'user' AND member.participant_id = $2
		    AND member.left_at IS NULL
		  WHERE conversation.workspace_id = $1 AND conversation.status = 'open'
		  ORDER BY conversation.updated_at DESC
		  LIMIT 1`,
		workspaceID, userID, agentID,
	).Scan(&conversationID)
	if err == nil {
		return conversationID, tx.Commit(ctx)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errors.New("find agent thread")
	}

	if err := tx.QueryRow(
		ctx,
		`INSERT INTO conversations
		    (workspace_id, kind, topic, status, created_by, created_at, updated_at)
		 VALUES ($1, 'direct', $2, 'open', $3, $4, $4)
		 RETURNING id`,
		workspaceID, agentName, userID, now,
	).Scan(&conversationID); err != nil {
		return uuid.Nil, errors.New("open agent thread")
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO conversation_participants
		    (conversation_id, participant_type, participant_id, role, joined_at)
		 VALUES ($1, 'user', $2, 'owner', $4), ($1, 'agent', $3, 'member', $4)`,
		conversationID, userID, agentID, now,
	); err != nil {
		return uuid.Nil, errors.New("add thread participants")
	}
	return conversationID, tx.Commit(ctx)
}

// Append records one turn and marks the thread active.
func (repository *Repository) Append(
	ctx context.Context,
	conversationID uuid.UUID,
	authorType string,
	authorID *uuid.UUID,
	body string,
	now time.Time,
) (uuid.UUID, error) {
	text := strings.TrimSpace(body)
	if conversationID == uuid.Nil || text == "" {
		return uuid.Nil, errors.New("message body is required")
	}
	tx, err := repository.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return uuid.Nil, errors.New("begin message append")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var messageID uuid.UUID
	if err := tx.QueryRow(
		ctx,
		`INSERT INTO conversation_messages
		    (conversation_id, author_type, author_id, body, channel, direction, created_at)
		 VALUES ($1, $2, $3, $4, 'in_app', 'internal', $5)
		 RETURNING id`,
		conversationID, authorType, authorID, text, now,
	).Scan(&messageID); err != nil {
		return uuid.Nil, errors.New("append message")
	}
	// Ordering the sidebar by updated_at only works if every turn touches it.
	if _, err := tx.Exec(
		ctx,
		`UPDATE conversations SET updated_at = $2 WHERE id = $1`,
		conversationID, now,
	); err != nil {
		return uuid.Nil, errors.New("touch conversation")
	}
	return messageID, tx.Commit(ctx)
}

// AgentFor returns the agent participating in a thread, if any.
func (repository *Repository) AgentFor(
	ctx context.Context,
	workspaceID, conversationID uuid.UUID,
) (uuid.UUID, uuid.UUID, error) {
	var agentID, upstreamID uuid.UUID
	err := repository.Pool.QueryRow(
		ctx,
		`SELECT agent.id, agent.openfang_agent_id
		   FROM conversation_participants AS participant
		   JOIN agents AS agent ON agent.id = participant.participant_id
		   JOIN conversations AS conversation
		     ON conversation.id = participant.conversation_id
		    AND conversation.workspace_id = $1
		  WHERE participant.conversation_id = $2
		    AND participant.participant_type = 'agent'
		    AND participant.left_at IS NULL
		    AND agent.archived_at IS NULL
		  LIMIT 1`,
		workspaceID, conversationID,
	).Scan(&agentID, &upstreamID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, ErrAgentNotFound
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, errors.New("resolve thread agent")
	}
	return agentID, upstreamID, nil
}
