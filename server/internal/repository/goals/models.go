// Package goals owns the outcome a person asked for: the header that issues,
// workflows and approvals hang off, its lifecycle, and the events it emits.
package goals

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

var (
	// ErrNotFound hides absent and archived goals behind one result.
	ErrNotFound = errors.New("goal not found")
	// ErrConflict is a uniqueness or concurrent-state conflict safe to expose.
	ErrConflict = errors.New("goal conflict")
	// ErrInvalidTransition means the requested status does not follow from
	// the current one; the value carries both for the error envelope.
	ErrInvalidTransition = errors.New("invalid goal transition")
)

// Status is the goal lifecycle. blocked is toggled by the dispatcher when a
// goal's work waits on something a person must do.
type Status string

const (
	StatusDraft     Status = "draft"
	StatusPlanned   Status = "planned"
	StatusActive    Status = "active"
	StatusBlocked   Status = "blocked"
	StatusCompleted Status = "completed"
	StatusCancelled Status = "cancelled"
)

// Valid reports whether the status is persisted by the schema.
func (status Status) Valid() bool {
	switch status {
	case StatusDraft, StatusPlanned, StatusActive, StatusBlocked, StatusCompleted, StatusCancelled:
		return true
	}
	return false
}

// Terminal reports whether no further transition is expected.
func (status Status) Terminal() bool {
	return status == StatusCompleted || status == StatusCancelled
}

var transitions = map[Status][]Status{
	StatusDraft:   {StatusPlanned, StatusActive, StatusCancelled},
	StatusPlanned: {StatusActive, StatusCancelled},
	StatusActive:  {StatusBlocked, StatusCompleted, StatusCancelled},
	StatusBlocked: {StatusActive, StatusCompleted, StatusCancelled},
}

// CanTransition applies the lifecycle draft → planned → active ⇄ blocked →
// completed | cancelled. Terminal goals never move again.
func CanTransition(from, to Status) bool {
	for _, allowed := range transitions[from] {
		if allowed == to {
			return true
		}
	}
	return false
}

// Source records whether a person or the planner wrote the goal.
type Source string

const (
	SourceManual Source = "manual"
	SourceAI     Source = "ai"
)

// Goal is a storage-neutral goal record.
type Goal struct {
	ID           uuid.UUID
	WorkspaceID  uuid.UUID
	ProjectID    *uuid.UUID
	Title        string
	Description  *string
	Status       Status
	Source       Source
	SourcePrompt *string
	CreatedBy    *uuid.UUID
	CreatedAt    time.Time
	UpdatedAt    time.Time
	StartedAt    *time.Time
	CompletedAt  *time.Time
}

// Cursor is the stable (updatedAt, id) descending list key.
type Cursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

// ListFilter narrows a workspace listing.
type ListFilter struct {
	Query     string
	Status    Status
	ProjectID *uuid.UUID
}

// CreateParams is one goal creation.
type CreateParams struct {
	ID           uuid.UUID
	WorkspaceID  uuid.UUID
	ProjectID    *uuid.UUID
	Title        string
	Description  *string
	Status       Status
	Source       Source
	SourcePrompt *string
	CreatedBy    uuid.UUID
	CreatedAt    time.Time
	// NewID mints the outbox event id; nil falls back to a random id.
	NewID func() uuid.UUID
}

// Patch distinguishes omitted fields from explicit nulls.
type Patch struct {
	Title          *string
	DescriptionSet bool
	Description    *string
	ProjectSet     bool
	ProjectID      *uuid.UUID
}

// Empty reports whether the patch changes nothing.
func (patch Patch) Empty() bool {
	return patch.Title == nil && !patch.DescriptionSet && !patch.ProjectSet
}

// Progress is what a goal page shows: how much of the goal's work is done,
// what automates it, and what waits on a person.
type Progress struct {
	IssuesTotal       int
	IssuesDone        int
	IssuesCancelled   int
	AutomationsActive int
	ApprovalsPending  int
}

// LinkedIssue is one issue attached to a goal.
type LinkedIssue struct {
	ID         uuid.UUID
	Identifier string
	Title      string
	// Status is the wire status of the issue.
	Status   string
	LinkedAt time.Time
}

// Event is the durable outbox fact a mutation returns for live publication.
type Event = ledger.Event

// TransitionError carries the refused move.
type TransitionError struct {
	From Status
	To   Status
}

func (err *TransitionError) Error() string { return ErrInvalidTransition.Error() }

func (err *TransitionError) Unwrap() error { return ErrInvalidTransition }
