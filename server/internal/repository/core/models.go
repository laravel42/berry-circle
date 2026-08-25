// Package core contains the Berry product repositories shared by the current
// authenticated HTTP contract lane.
package core

import (
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/issueid"
)

// ParseUUID accepts only canonical RFC 4122 text, unlike uuid.Parse's broader
// support for brace, URN, and hyphenless representations.
func ParseUUID(raw string) (uuid.UUID, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil || id.Variant() != uuid.RFC4122 ||
		!strings.EqualFold(id.String(), raw) {
		return uuid.Nil, errors.New("invalid canonical UUID")
	}
	return id, nil
}

var (
	// ErrNotFound deliberately carries no storage detail across the repository boundary.
	ErrNotFound = errors.New("core resource not found")
	// ErrConflict represents a safe uniqueness or concurrent-state conflict.
	ErrConflict = errors.New("core resource conflict")
	// ErrColumnInUse prevents removing a live workflow column.
	ErrColumnInUse = errors.New("board column is in use")
	// ErrInvalidStateTransition preserves the current and requested workflow states.
	ErrInvalidStateTransition = errors.New("invalid issue state transition")
	// ErrInvalidParent prevents comments deeper than one reply level.
	ErrInvalidParent = errors.New("invalid comment parent")
	// ErrForbidden represents an authenticated actor failing an ownership check.
	ErrForbidden = errors.New("core operation forbidden")
	// ErrRevisionConflict represents a stale optimistic comment write.
	ErrRevisionConflict = errors.New("comment revision conflict")
)

// BoardColumn is the persisted and public ordered workflow-column shape.
type BoardColumn struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Board is a storage-neutral board record.
type Board struct {
	ID          uuid.UUID
	Name        string
	Slug        string
	Description *string
	Columns     []BoardColumn
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// BoardCursor is the final stable key of a board page.
type BoardCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// BoardPatch distinguishes omitted fields from explicit nulls.
type BoardPatch struct {
	Name           *string
	Slug           *string
	DescriptionSet bool
	Description    *string
	Columns        *[]BoardColumn
}

// ActorKey identifies an actor before display data is resolved.
type ActorKey struct {
	Type string
	ID   uuid.UUID
}

// ActorRef is Berry's public embedded actor projection.
type ActorRef struct {
	Type      string    `json:"type"`
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatarUrl"`
}

// AssigneeInput is the writable portion of an ActorRef.
type AssigneeInput struct {
	Type string
	ID   uuid.UUID
}

// Issue is a storage-neutral issue plus its board identifier context.
type Issue struct {
	ID          uuid.UUID
	BoardID     uuid.UUID
	BoardSlug   string
	IssuePrefix string
	Number      int32
	Title       string
	Description *string
	Status      string
	Priority    string
	SortOrder   int32
	DueDate     *time.Time
	Assignee    *ActorRef
	ActiveRunID *uuid.UUID
	// Project is the project this issue belongs to, if any. An issue lives on
	// a board and may additionally be linked to one project, which is why this
	// is a reference rather than a column.
	Project   *ProjectRef
	CreatedBy *ActorRef
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Identifier is the public PREFIX-N key derived from the workspace prefix.
func (issue Issue) Identifier() string {
	return issueid.Format(issue.IssuePrefix, issue.Number)
}

// ProjectRef names the project an issue is linked to.
type ProjectRef struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// IssueCursor is the final stable key of an issue page.
type IssueCursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

// IssueListFilter contains normalized storage values.
type IssueListFilter struct {
	BoardID    uuid.UUID
	Statuses   []string
	Priorities []string
	Assignee   *AssigneeInput
	Query      *string
	After      *IssueCursor
	Limit      int
}

// CreateIssueParams contains all values needed for one atomic issue creation.
type CreateIssueParams struct {
	ID           uuid.UUID
	AssignmentID uuid.UUID
	BoardID      uuid.UUID
	Title        string
	Description  *string
	Status       string
	Priority     string
	SortOrder    int32
	DueDate      *time.Time
	Assignee     *AssigneeInput
	Project      *uuid.UUID
	CreatedBy    uuid.UUID
	CreatedAt    time.Time
}

// IssuePatch distinguishes omitted fields from explicit nullable values.
type IssuePatch struct {
	Title          *string
	DescriptionSet bool
	Description    *string
	Status         *string
	Priority       *string
	SortOrder      *int32
	DueDateSet     bool
	DueDate        *time.Time
	AssigneeSet    bool
	Assignee       *AssigneeInput
	// ProjectSet distinguishes "leave the project alone" from "clear it", the
	// same way DescriptionSet and DueDateSet do: a nil Project with the flag
	// unset means untouched, with the flag set means unlinked.
	ProjectSet bool
	Project    *uuid.UUID
}

// UpdateIssueParams carries a locked update and optional assignment history ID.
type UpdateIssueParams struct {
	IssueID      uuid.UUID
	Patch        IssuePatch
	AssignmentID uuid.UUID
	AssignedBy   uuid.UUID
	UpdatedAt    time.Time
}

// StateTransitionError carries safe public transition details.
type StateTransitionError struct {
	From string
	To   string
}

func (transition *StateTransitionError) Error() string {
	return ErrInvalidStateTransition.Error()
}

func (transition *StateTransitionError) Unwrap() error {
	return ErrInvalidStateTransition
}

// Comment is a storage-neutral comment with its resolved author.
type Comment struct {
	ID         uuid.UUID
	IssueID    uuid.UUID
	Body       string
	Author     ActorRef
	ParentID   *uuid.UUID
	Revision   int64
	ResolvedAt *time.Time
	ResolvedBy *ActorRef
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// CommentCursor is the final stable key of a comment page.
type CommentCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// CreateCommentParams contains one authenticated comment write.
type CreateCommentParams struct {
	ID      uuid.UUID
	IssueID uuid.UUID
	// AuthorType is "user" or "agent" (the assignee_type enum). Empty means
	// "user", which is what every caller was before agents could report on
	// the work they did.
	AuthorType string
	AuthorID   uuid.UUID
	Body       string
	ParentID   *uuid.UUID
	CreatedAt  time.Time
}

// RevisionConflictError carries the current safe revision for a retry.
type RevisionConflictError struct {
	CurrentRevision int64
}

func (conflict *RevisionConflictError) Error() string {
	return ErrRevisionConflict.Error()
}

func (conflict *RevisionConflictError) Unwrap() error {
	return ErrRevisionConflict
}

// CommentMutationEvent is a durable outbox fact returned after commit.
type CommentMutationEvent struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Type        string
	Payload     []byte
	OccurredAt  time.Time
}
