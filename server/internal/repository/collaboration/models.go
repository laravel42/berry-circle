// Package collaboration owns PostgreSQL persistence for P2 attachments,
// reactions, subscribers, and comment-resolution state.
package collaboration

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound intentionally combines absent and cross-workspace resources.
	ErrNotFound = errors.New("collaboration resource not found")
	// ErrForbidden means an active member lacks the explicit requested permission.
	ErrForbidden = errors.New("collaboration operation forbidden")
	// ErrConflict represents a uniqueness or optimistic-state conflict.
	ErrConflict = errors.New("collaboration resource conflict")
)

// TargetKind selects the owner of a reaction.
type TargetKind string

const (
	TargetIssue   TargetKind = "issue"
	TargetComment TargetKind = "comment"
)

// Actor is a safe user projection.
type Actor struct {
	ID        uuid.UUID
	Name      string
	AvatarURL *string
}

// Attachment is metadata only. StorageKey is private implementation data and
// must never be serialized by HTTP handlers.
type Attachment struct {
	ID             uuid.UUID
	WorkspaceID    uuid.UUID
	IssueID        uuid.UUID
	CommentID      *uuid.UUID
	Uploader       *Actor
	FileName       string
	ContentType    string
	SizeBytes      int64
	ChecksumSHA256 [32]byte
	StorageKey     string
	State          string
	CreatedAt      time.Time
	ReadyAt        *time.Time
}

// AttachmentCursor is the oldest-first stable list key.
type AttachmentCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// ReserveAttachmentParams records invisible metadata before object storage is
// contacted.
type ReserveAttachmentParams struct {
	ID             uuid.UUID
	IssueReference string
	CommentID      *uuid.UUID
	UploaderID     uuid.UUID
	FileName       string
	ContentType    string
	SizeBytes      int64
	ChecksumSHA256 [32]byte
	CreatedAt      time.Time
}

// Reaction is one actor's emoji on an issue or comment.
type Reaction struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	TargetKind  TargetKind
	TargetID    uuid.UUID
	Actor       Actor
	Emoji       string
	CreatedAt   time.Time
}

// ReactionCursor is the oldest-first stable list key.
type ReactionCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// Subscriber is one active workspace member following an issue.
type Subscriber struct {
	WorkspaceID uuid.UUID
	IssueID     uuid.UUID
	User        Actor
	Reason      string
	CreatedAt   time.Time
}

// SubscriberCursor is the oldest-first stable list key.
type SubscriberCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	UserID    uuid.UUID `json:"userId"`
}

// Event is a durable outbox fact returned only after its transaction commits.
type Event struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Topic         string
	AggregateType string
	AggregateID   uuid.UUID
	Payload       json.RawMessage
	OccurredAt    time.Time
}

// Resolution describes additive comment lifecycle fields.
type Resolution struct {
	CommentID uuid.UUID
	IssueID   uuid.UUID
	Revision  int64
	Resolved  bool
	At        *time.Time
	By        *Actor
}

// ResolutionResult includes all durable events caused by a thread-scoped
// resolve. Resolving a sibling can atomically unresolve the old choice.
type ResolutionResult struct {
	Resolution Resolution
	Events     []Event
}
