// Package p2 contains PostgreSQL repositories for Berry's P2 query, saved
// views, pins, inbox, notification preferences, and outbox projection lane.
package p2

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound         = errors.New("p2 resource not found")
	ErrConflict         = errors.New("p2 resource conflict")
	ErrRevisionConflict = errors.New("saved view revision conflict")
	ErrInvalidOrder     = errors.New("pin order does not match current pins")
	ErrQueryTimeout     = errors.New("p2 query timed out")
)

type SavedView struct {
	ID                uuid.UUID
	WorkspaceID       uuid.UUID
	OwnerID           uuid.UUID
	Name              string
	Visibility        string
	DefinitionVersion int
	Query             json.RawMessage
	Display           json.RawMessage
	Revision          int
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type SavedViewCursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

type CreateSavedViewParams struct {
	ID                uuid.UUID
	WorkspaceID       uuid.UUID
	OwnerID           uuid.UUID
	Name              string
	Visibility        string
	DefinitionVersion int
	Query             json.RawMessage
	Display           json.RawMessage
	CreatedAt         time.Time
}

type UpdateSavedViewParams struct {
	ID               uuid.UUID
	WorkspaceID      uuid.UUID
	ActorID          uuid.UUID
	Name             *string
	Visibility       *string
	Query            json.RawMessage
	Display          json.RawMessage
	ExpectedRevision int
	UpdatedAt        time.Time
}

type ViewPreference struct {
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	ActiveView  *uuid.UUID
	Preferences json.RawMessage
	UpdatedAt   *time.Time
}

type Pin struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	TargetType  string
	TargetID    uuid.UUID
	Position    int
	CreatedAt   time.Time
}

type InboxItem struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	RecipientID   uuid.UUID
	SourceEventID *uuid.UUID
	EventType     string
	Category      string
	Severity      string
	IssueID       *uuid.UUID
	IssueStatus   *string
	// Human identifier ("PLATFORM-3"), derived from the issue's board slug and
	// number at read time. Not stored: deriving it repairs rows already
	// projected, which a write-time column would leave showing a raw id.
	IssueIdentifier *string
	ActorType       *string
	ActorID         *uuid.UUID
	Title           string
	Body            *string
	Details         json.RawMessage
	ReadAt          *time.Time
	ArchivedAt      *time.Time
	CreatedAt       time.Time
}

type InboxCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

type InboxFilter struct {
	State      string
	UnreadOnly bool
	After      *InboxCursor
	Limit      int
}

type NotificationPreferences struct {
	WorkspaceID uuid.UUID
	UserID      uuid.UUID
	Preferences json.RawMessage
	UpdatedAt   *time.Time
}

type SearchCursor struct {
	Rank         int       `json:"rank"`
	Normalized   string    `json:"normalized"`
	ResourceType string    `json:"resourceType"`
	ID           uuid.UUID `json:"id"`
}

type SearchResult struct {
	Type       string
	ID         uuid.UUID
	Title      string
	Subtitle   *string
	Identifier *string
	BoardID    *uuid.UUID
	Rank       int
	Normalized string
}

type SearchFilter struct {
	Query string
	Types []string
	After *SearchCursor
	Limit int
}

type IssueFilter struct {
	BoardIDs     []uuid.UUID     `json:"boardIds,omitempty"`
	Statuses     []string        `json:"statuses,omitempty"`
	Priorities   []string        `json:"priorities,omitempty"`
	AssigneeType *string         `json:"assigneeType,omitempty"`
	AssigneeID   *uuid.UUID      `json:"assigneeId,omitempty"`
	AssignedToMe bool            `json:"assignedToMe,omitempty"`
	Query        *string         `json:"query,omitempty"`
	CreatedAfter *time.Time      `json:"createdAfter,omitempty"`
	UpdatedAfter *time.Time      `json:"updatedAfter,omitempty"`
	UserID       uuid.UUID       `json:"-"`
	Extra        json.RawMessage `json:"-"`
}

type IssueGroupCursor struct {
	Count int64  `json:"count"`
	Key   string `json:"key"`
}

type IssueGroup struct {
	Key   string
	Label string
	Count int64
}

type IssueRowCursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

type IssueRow struct {
	ID           uuid.UUID
	BoardID      uuid.UUID
	Identifier   string
	Title        string
	Status       string
	Priority     string
	AssigneeType *string
	AssigneeID   *uuid.UUID
	DueDate      *time.Time
	UpdatedAt    time.Time
}

type FacetCount struct {
	Facet string `json:"facet"`
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int64  `json:"count"`
}

type BatchIssuePatch struct {
	Status   *string
	Priority *string
}

type BatchResult struct {
	ID      uuid.UUID `json:"id"`
	Outcome string    `json:"outcome"`
}

type ProjectionResult struct {
	Events int
	Items  int
}
