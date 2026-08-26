// Package automation owns the persistence of workflows (Go noun: automation):
// the definition and its versions, the run ledger with its step rows and
// events, trigger receipts, and the outbox facts each transition emits.
package automation

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/automation"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

var (
	// ErrNotFound hides absent and cross-workspace rows behind one result.
	ErrNotFound = errors.New("automation not found")
	// ErrConflict is a uniqueness or concurrent-state conflict safe to expose.
	ErrConflict = errors.New("automation conflict")
	// ErrRevisionConflict means the caller edited a stale copy.
	ErrRevisionConflict = errors.New("automation revision conflict")
	// ErrActive means the definition cannot change while the workflow runs;
	// pause it first.
	ErrActive = errors.New("automation is active")
	// ErrNotActive means a run was requested on a workflow that is not active;
	// drafts and paused workflows never run.
	ErrNotActive = errors.New("automation is not active")
	// ErrInvalidTransition means the status move does not follow the lifecycle.
	ErrInvalidTransition = errors.New("invalid automation transition")
	// ErrRunTerminal means the run already finished.
	ErrRunTerminal = errors.New("automation run is terminal")
	// ErrRunState means the run is not in the state the transition needs.
	ErrRunState = errors.New("automation run state conflict")
	// ErrStepState means the step run is not in the state the transition needs.
	ErrStepState = errors.New("automation step state conflict")
	// ErrCursorExpired is the shared ledger cursor error.
	ErrCursorExpired = ledger.ErrCursorExpired
)

// Status is the workflow lifecycle.
type Status string

const (
	StatusDraft    Status = "draft"
	StatusActive   Status = "active"
	StatusPaused   Status = "paused"
	StatusArchived Status = "archived"
)

// Engine names what executes the workflow.
type Engine string

const (
	EngineNative       Engine = "native"
	EngineActivepieces Engine = "activepieces"
)

// EngineSyncStatus tracks the mirror in an external engine.
type EngineSyncStatus string

const (
	EngineSyncNotRequired EngineSyncStatus = "not_required"
	EngineSyncPending     EngineSyncStatus = "pending"
	EngineSyncSynced      EngineSyncStatus = "synced"
	EngineSyncFailed      EngineSyncStatus = "failed"
)

// RunStatus is the run lifecycle.
type RunStatus string

const (
	RunPending   RunStatus = "pending"
	RunRunning   RunStatus = "running"
	RunWaiting   RunStatus = "waiting"
	RunSucceeded RunStatus = "succeeded"
	RunFailed    RunStatus = "failed"
	RunCancelled RunStatus = "cancelled"
)

// Terminal reports whether the run finished.
func (status RunStatus) Terminal() bool {
	return status == RunSucceeded || status == RunFailed || status == RunCancelled
}

// StepStatus is the step run lifecycle.
type StepStatus string

const (
	StepPending   StepStatus = "pending"
	StepRunning   StepStatus = "running"
	StepWaiting   StepStatus = "waiting"
	StepSucceeded StepStatus = "succeeded"
	StepFailed    StepStatus = "failed"
	StepSkipped   StepStatus = "skipped"
)

// Terminal reports whether the step attempt finished.
func (status StepStatus) Terminal() bool {
	return status == StepSucceeded || status == StepFailed || status == StepSkipped
}

// Trigger is the indexed trigger metadata of a workflow.
type Trigger struct {
	Type      automation.TriggerType
	Provider  string
	Operation string
	Event     string
	Cron      string
	Timezone  string
}

// Automation is a storage-neutral workflow record. Definition is the stored
// JSON exactly as validated; Layout is the canvas positions and never
// business state.
type Automation struct {
	ID                uuid.UUID
	WorkspaceID       uuid.UUID
	ProjectID         *uuid.UUID
	GoalID            *uuid.UUID
	Name              string
	Description       *string
	Status            Status
	Version           int
	Revision          int
	Definition        json.RawMessage
	DefinitionVersion string
	Layout            json.RawMessage
	Trigger           Trigger
	ScheduleNextAt    *time.Time
	HasWebhookSecret  bool
	Risk              automation.Risk
	Engine            Engine
	EngineFlowID      *string
	EngineSyncStatus  EngineSyncStatus
	EngineSyncError   *string
	CreatedBy         *uuid.UUID
	CreatedAt         time.Time
	UpdatedAt         time.Time
	ArchivedAt        *time.Time
}

// Version is one immutable definition snapshot.
type Version struct {
	ID                  uuid.UUID
	WorkspaceID         uuid.UUID
	AutomationID        uuid.UUID
	Version             int
	Definition          json.RawMessage
	DefinitionVersion   string
	EngineFlowVersionID *string
	CreatedBy           *uuid.UUID
	CreatedAt           time.Time
}

// Failure is a stable code and client-safe summary.
type Failure struct {
	Code    string
	Message string
}

// Usage is the summed inline model usage of a run.
type Usage struct {
	InputTokens  int64
	OutputTokens int64
	CostMicros   *int64
}

// Run is a storage-neutral workflow run record.
type Run struct {
	ID                uuid.UUID
	WorkspaceID       uuid.UUID
	AutomationID      uuid.UUID
	AutomationVersion int
	GoalID            *uuid.UUID
	Status            RunStatus
	TriggerType       automation.TriggerType
	TriggerPayload    json.RawMessage
	SourceEventKey    *string
	CurrentStepID     *string
	WaitingOn         *string
	ResumeAt          *time.Time
	Sequence          int64
	Engine            Engine
	EngineRunID       *string
	Failure           *Failure
	Usage             Usage
	RequestedBy       *uuid.UUID
	RequestID         *string
	CreatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	UpdatedAt         time.Time
}

// StepRun is one execution attempt of one step.
type StepRun struct {
	ID           uuid.UUID
	WorkspaceID  uuid.UUID
	RunID        uuid.UUID
	StepID       string
	StepType     automation.StepType
	Attempt      int
	Status       StepStatus
	Input        json.RawMessage
	Output       json.RawMessage
	Failure      *Failure
	IssueRunID   *uuid.UUID
	IssueID      *uuid.UUID
	ApprovalID   *uuid.UUID
	AuditEventID *uuid.UUID
	EngineStepID *string
	Usage        json.RawMessage
	StartedAt    *time.Time
	CompletedAt  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// RunEvent is one replayed run ledger event.
type RunEvent struct {
	ID           uuid.UUID
	Type         string
	OccurredAt   time.Time
	WorkspaceID  uuid.UUID
	AutomationID uuid.UUID
	RunID        uuid.UUID
	StepID       *string
	Sequence     int64
	Payload      json.RawMessage
}

// Event is the durable outbox fact a mutation returns for live publication.
type Event = ledger.Event

// Cursor is the stable (updatedAt, id) descending list key.
type Cursor struct {
	UpdatedAt time.Time `json:"updatedAt"`
	ID        uuid.UUID `json:"id"`
}

// RunCursor is the stable (createdAt, id) descending run list key.
type RunCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// ListFilter narrows a workspace listing.
type ListFilter struct {
	Status      Status
	TriggerType automation.TriggerType
	GoalID      *uuid.UUID
	ProjectID   *uuid.UUID
	Query       string
}

// RunListFilter narrows a run listing to a workspace or one workflow.
type RunListFilter struct {
	WorkspaceID  uuid.UUID
	AutomationID *uuid.UUID
	Status       RunStatus
}

// CreateParams is one workflow creation. Definition must already have passed
// ValidateDefinition; the repository derives the indexed metadata from it.
type CreateParams struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	ProjectID   *uuid.UUID
	GoalID      *uuid.UUID
	Name        string
	Description *string
	Definition  automation.Definition
	Layout      json.RawMessage
	Engine      Engine
	// Catalog informs the derived risk; nil assumes every action is medium.
	Catalog   automation.Catalog
	CreatedBy uuid.UUID
	CreatedAt time.Time
	// NewID mints the version and outbox event ids; nil falls back to random ids.
	NewID func() uuid.UUID
}

// UpdateParams is one optimistic edit. A definition change is allowed only
// while the workflow is draft or paused and always snapshots a new version.
type UpdateParams struct {
	AutomationID     uuid.UUID
	ExpectedRevision int
	Name             *string
	DescriptionSet   bool
	Description      *string
	Definition       *automation.Definition
	Layout           json.RawMessage
	GoalSet          bool
	GoalID           *uuid.UUID
	ProjectSet       bool
	ProjectID        *uuid.UUID
	Catalog          automation.Catalog
	ActorID          uuid.UUID
	UpdatedAt        time.Time
	NewID            func() uuid.UUID
}

// CreateRunParams is one run request. SourceEventKey makes the request
// idempotent per workflow: the outbox event's public id for triggered runs,
// a schedule tick key for scheduled ones, nil for manual runs.
type CreateRunParams struct {
	ID             uuid.UUID
	AutomationID   uuid.UUID
	TriggerType    automation.TriggerType
	Payload        json.RawMessage
	SourceEventKey *string
	RequestedBy    *uuid.UUID
	RequestID      string
	CreatedAt      time.Time
}

// StartStepParams opens one step attempt.
type StartStepParams struct {
	ID       uuid.UUID
	RunID    uuid.UUID
	StepID   string
	StepType automation.StepType
	Attempt  int
	Input    json.RawMessage
	Now      time.Time
	NewID    func() uuid.UUID
}

// StepLinks are the rows a step attempt produced or waits on.
type StepLinks struct {
	IssueRunID   *uuid.UUID
	IssueID      *uuid.UUID
	ApprovalID   *uuid.UUID
	AuditEventID *uuid.UUID
	EngineStepID *string
}

// TriggerEvent is one claimed outbox event.
type TriggerEvent struct {
	ID            uuid.UUID
	Topic         string
	AggregateType string
	AggregateID   uuid.UUID
	WorkspaceID   *uuid.UUID
	BoardID       *uuid.UUID
	Payload       json.RawMessage
	OccurredAt    time.Time
}

// ReceiptOutcome records what the dispatcher did with an event.
type ReceiptOutcome string

const (
	ReceiptMatched   ReceiptOutcome = "matched"
	ReceiptUnmatched ReceiptOutcome = "unmatched"
	ReceiptSkipped   ReceiptOutcome = "skipped"
	ReceiptFailed    ReceiptOutcome = "failed"
)
