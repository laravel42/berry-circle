// Package catalogs owns workspace-scoped issue labels, workflow definitions,
// typed properties, and hidden-prompt quick actions.
package catalogs

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	// ErrNotFound hides absent and cross-workspace catalog rows.
	ErrNotFound = errors.New("catalog resource not found")
	// ErrConflict represents a catalog uniqueness or reorder conflict.
	ErrConflict = errors.New("catalog resource conflict")
	// ErrSystemDefinition protects seeded workflow definitions.
	ErrSystemDefinition = errors.New("system workflow definition cannot be archived")
	// ErrInvalidValue rejects a value that does not match its definition.
	ErrInvalidValue = errors.New("property value does not match definition")
)

// TimeCursor is the descending stable key used by name-search catalogs.
type TimeCursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

// PositionCursor is the ascending stable key used by ordered definitions.
type PositionCursor struct {
	SortOrder int       `json:"sortOrder"`
	ID        uuid.UUID `json:"id"`
}

// ListFilter contains normalized search and archive filters.
type ListFilter struct {
	Query           string
	IncludeArchived bool
}

// Label is one workspace issue-label definition.
type Label struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Color       string
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
	ArchivedAt  *time.Time
}

// CreateLabelParams contains normalized server-owned label identity.
type CreateLabelParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Color       string
	CreatedBy   uuid.UUID
	CreatedAt   time.Time
}

// LabelPatch is a non-empty mutable label subset.
type LabelPatch struct {
	Name           *string
	DescriptionSet bool
	Description    *string
	Color          *string
}

// WorkflowCategory is immutable Berry workflow behavior on the wire.
type WorkflowCategory string

const (
	CategoryBacklog    WorkflowCategory = "backlog"
	CategoryTodo       WorkflowCategory = "todo"
	CategoryInProgress WorkflowCategory = "inProgress"
	CategoryInReview   WorkflowCategory = "inReview"
	CategoryDone       WorkflowCategory = "done"
	CategoryBlocked    WorkflowCategory = "blocked"
	CategoryCancelled  WorkflowCategory = "cancelled"
)

// Valid reports whether category is one of Berry's immutable behaviors.
func (category WorkflowCategory) Valid() bool {
	switch category {
	case CategoryBacklog,
		CategoryTodo,
		CategoryInProgress,
		CategoryInReview,
		CategoryDone,
		CategoryBlocked,
		CategoryCancelled:
		return true
	default:
		return false
	}
}

// StatusDefinition separates an immutable category from mutable presentation.
type StatusDefinition struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Key         string
	Name        string
	Description *string
	Category    WorkflowCategory
	Color       string
	SortOrder   int
	IsSystem    bool
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
	ArchivedAt  *time.Time
}

// CreateStatusParams contains normalized custom status input.
type CreateStatusParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Key         string
	Name        string
	Description *string
	Category    WorkflowCategory
	Color       string
	SortOrder   int
	CreatedBy   uuid.UUID
	CreatedAt   time.Time
}

// StatusPatch intentionally omits key, category, and system identity.
type StatusPatch struct {
	Name           *string
	DescriptionSet bool
	Description    *string
	Color          *string
	SortOrder      *int
}

// PropertyKind selects one strict JSON value shape.
type PropertyKind string

const (
	PropertyText        PropertyKind = "text"
	PropertyNumber      PropertyKind = "number"
	PropertyBoolean     PropertyKind = "boolean"
	PropertyDate        PropertyKind = "date"
	PropertyURL         PropertyKind = "url"
	PropertySelect      PropertyKind = "select"
	PropertyMultiSelect PropertyKind = "multiSelect"
)

// Valid reports whether kind is implemented by the typed value seam.
func (kind PropertyKind) Valid() bool {
	switch kind {
	case PropertyText,
		PropertyNumber,
		PropertyBoolean,
		PropertyDate,
		PropertyURL,
		PropertySelect,
		PropertyMultiSelect:
		return true
	default:
		return false
	}
}

// PropertyOption is a stable select value.
type PropertyOption struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

// PropertyConfig is empty except for select and multi-select definitions.
type PropertyConfig struct {
	Options []PropertyOption `json:"options,omitempty"`
}

// PropertyDefinition is one workspace custom field.
type PropertyDefinition struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Kind        PropertyKind
	Config      PropertyConfig
	Icon        *string
	SortOrder   int
	CreatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
	ArchivedAt  *time.Time
}

// CreatePropertyParams contains normalized custom-field input.
type CreatePropertyParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Name        string
	Description *string
	Kind        PropertyKind
	Config      PropertyConfig
	Icon        *string
	SortOrder   int
	CreatedBy   uuid.UUID
	CreatedAt   time.Time
}

// PropertyPatch intentionally keeps Kind immutable.
type PropertyPatch struct {
	Name           *string
	DescriptionSet bool
	Description    *string
	Config         *PropertyConfig
	IconSet        bool
	Icon           *string
	SortOrder      *int
}

// PropertyValue is one typed per-issue value.
type PropertyValue struct {
	WorkspaceID uuid.UUID
	IssueID     uuid.UUID
	PropertyID  uuid.UUID
	Value       json.RawMessage
	UpdatedBy   *uuid.UUID
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// QuickActionVisibility controls definition discovery, never execution rights.
type QuickActionVisibility string

const (
	QuickActionPrivate   QuickActionVisibility = "private"
	QuickActionWorkspace QuickActionVisibility = "workspace"
)

// Valid reports whether visibility is persisted by migration 005.
func (visibility QuickActionVisibility) Valid() bool {
	return visibility == QuickActionPrivate || visibility == QuickActionWorkspace
}

// QuickAction is safe public metadata. The hidden prompt is deliberately absent.
type QuickAction struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Name          string
	Description   *string
	TargetAgentID uuid.UUID
	Visibility    QuickActionVisibility
	CreatedBy     uuid.UUID
	CreatedAt     time.Time
	UpdatedAt     time.Time
	ArchivedAt    *time.Time
}

// CreateQuickActionParams contains the write-only hidden prompt.
type CreateQuickActionParams struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Name          string
	Description   *string
	TargetAgentID uuid.UUID
	Prompt        string
	Visibility    QuickActionVisibility
	CreatedBy     uuid.UUID
	CreatedAt     time.Time
}

// QuickActionPatch permits prompt replacement without returning it.
type QuickActionPatch struct {
	Name           *string
	DescriptionSet bool
	Description    *string
	TargetAgentID  *uuid.UUID
	Prompt         *string
	Visibility     *QuickActionVisibility
}

// QuickActionRender is the safe user-visible preview boundary.
type QuickActionRender struct {
	ActionID      uuid.UUID
	IssueID       uuid.UUID
	Name          string
	Description   *string
	TargetAgentID uuid.UUID
	Ready         bool
}

// QuickActionInvocation is server-only dispatch input. Prompt can never be
// serialized into an HTTP response, log field, or idempotency replay.
type QuickActionInvocation struct {
	ActionID      uuid.UUID `json:"actionId"`
	WorkspaceID   uuid.UUID `json:"workspaceId"`
	IssueID       uuid.UUID `json:"issueId"`
	TargetAgentID uuid.UUID `json:"targetAgentId"`
	ActorID       uuid.UUID `json:"actorId"`
	Prompt        string    `json:"-"`
}

// QuickActionRun is the safe future executor result.
type QuickActionRun struct {
	RunID    uuid.UUID
	Accepted bool
}
