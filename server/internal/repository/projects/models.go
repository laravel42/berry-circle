// Package projects owns workspace-scoped P2 projects, resources, and the
// narrow issue-link service seam.
package projects

import (
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound hides absent and cross-workspace project rows.
	ErrNotFound = errors.New("project resource not found")
	// ErrConflict represents an active uniqueness conflict.
	ErrConflict = errors.New("project resource conflict")
)

// Status is the planning lifecycle of a project.
type Status string

const (
	StatusPlanned   Status = "planned"
	StatusActive    Status = "active"
	StatusPaused    Status = "paused"
	StatusCompleted Status = "completed"
	StatusCancelled Status = "cancelled"
)

// Valid reports whether status is persisted by migration 005.
func (status Status) Valid() bool {
	switch status {
	case StatusPlanned, StatusActive, StatusPaused, StatusCompleted, StatusCancelled:
		return true
	default:
		return false
	}
}

// Priority is the ordering signal for a project.
type Priority string

const (
	PriorityNone   Priority = "none"
	PriorityLow    Priority = "low"
	PriorityMedium Priority = "medium"
	PriorityHigh   Priority = "high"
	PriorityUrgent Priority = "urgent"
)

// Valid reports whether priority is persisted by migration 005.
func (priority Priority) Valid() bool {
	switch priority {
	case PriorityNone, PriorityLow, PriorityMedium, PriorityHigh, PriorityUrgent:
		return true
	default:
		return false
	}
}

// ResourceKind is a safe external-link presentation category.
type ResourceKind string

const (
	ResourceLink       ResourceKind = "link"
	ResourceDocument   ResourceKind = "document"
	ResourceRepository ResourceKind = "repository"
)

// Valid reports whether kind is persisted by migration 005.
func (kind ResourceKind) Valid() bool {
	switch kind {
	case ResourceLink, ResourceDocument, ResourceRepository:
		return true
	default:
		return false
	}
}

// Project is one active workspace planning object.
type Project struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Status      Status
	Priority    Priority
	StartDate   *time.Time
	TargetDate  *time.Time
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Cursor is the descending stable project-list key.
type Cursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

// ListFilter contains normalized bounded project filters.
type ListFilter struct {
	Query    string
	Status   *Status
	Priority *Priority
}

// CreateParams contains server-owned identity and normalized input.
type CreateParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Status      Status
	Priority    Priority
	StartDate   *time.Time
	TargetDate  *time.Time
	CreatedBy   uuid.UUID
	CreatedAt   time.Time
}

// Patch distinguishes omitted nullable fields from explicit null.
type Patch struct {
	Name           *string
	DescriptionSet bool
	Description    *string
	Status         *Status
	Priority       *Priority
	StartDateSet   bool
	StartDate      *time.Time
	TargetDateSet  bool
	TargetDate     *time.Time
}

// Resource is one active external pointer attached to a project.
type Resource struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	ProjectID   uuid.UUID
	Kind        ResourceKind
	URL         string
	Label       *string
	Description *string
	SortOrder   int
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ResourceCursor is the ascending stable resource-list key.
type ResourceCursor struct {
	SortOrder int       `json:"sortOrder"`
	ID        uuid.UUID `json:"id"`
}

// CreateResourceParams contains normalized resource input.
type CreateResourceParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	ProjectID   uuid.UUID
	Kind        ResourceKind
	URL         string
	Label       *string
	Description *string
	SortOrder   int
	CreatedBy   uuid.UUID
	CreatedAt   time.Time
}

// ResourcePatch is a non-empty partial external-resource update.
type ResourcePatch struct {
	Kind           *ResourceKind
	URL            *string
	LabelSet       bool
	Label          *string
	DescriptionSet bool
	Description    *string
	SortOrder      *int
}
