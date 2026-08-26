// Package runs owns Berry's durable issue-correlated run ledger.
package runs

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

// Status is the unchanged public run lifecycle enum.
type Status string

const (
	StatusQueued    Status = "queued"
	StatusRunning   Status = "running"
	StatusSucceeded Status = "succeeded"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
)

// DispatchState is internal exactly-once/reconciliation state.
type DispatchState string

const (
	DispatchPending                DispatchState = "pending"
	Dispatching                    DispatchState = "dispatching"
	DispatchStreaming              DispatchState = "streaming"
	DispatchSucceeded              DispatchState = "succeeded"
	DispatchFailed                 DispatchState = "failed"
	DispatchCancelRequested        DispatchState = "cancel_requested"
	DispatchCancelled              DispatchState = "cancelled"
	DispatchReconciliationRequired DispatchState = "reconciliation_required"
)

// Usage is cumulative normalized run usage.
type Usage struct {
	InputTokens  int64
	OutputTokens int64
	TotalTokens  int64
	CostMicros   *int64
	Currency     *string
}

// Failure contains only a stable code and client-safe summary.
type Failure struct {
	Code      string
	Message   string
	Retryable bool
}

// Run is the storage-neutral durable ledger record.
type Run struct {
	ID      uuid.UUID
	IssueID uuid.UUID
	BoardID uuid.UUID
	// WorkspaceID is the board's workspace, read alongside the run so every
	// event the run emits can carry both scopes without a second lookup.
	WorkspaceID       uuid.UUID
	AgentID           uuid.UUID
	UpstreamAgentID   uuid.UUID
	Status            Status
	Sequence          int64
	Summary           *string
	Output            string
	Usage             Usage
	Failure           *Failure
	DispatchState     DispatchState
	DispatchVersion   int64
	UpstreamRequestID *string
	RequestID         *string
	CancelRequestedAt *time.Time
	CancelAttemptedAt *time.Time
	CreatedAt         time.Time
	StartedAt         *time.Time
	CompletedAt       *time.Time
	UpdatedAt         time.Time
}

// Terminal reports whether no more public lifecycle transition is expected.
func (run Run) Terminal() bool {
	return run.Status == StatusSucceeded ||
		run.Status == StatusFailed ||
		run.Status == StatusCancelled
}

// Event is one persisted public event and opaque replay cursor. It is the
// shared ledger event: the run ledger and the outbox replays both produce it,
// so the board and workspace streams read one shape.
type Event = ledger.Event

// Cursor is the stable (createdAt, id) run-list key.
type Cursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        uuid.UUID `json:"id"`
}

// BoardCursor is the stable outbox replay key resolved from an opaque event ID.
// The same (occurred_at, id) pair orders the workspace replay.
type BoardCursor = ledger.OutboxCursor

// ListFilter is a normalized forward run page scoped to one issue.
type ListFilter struct {
	IssueID uuid.UUID
	Status  Status
	After   *Cursor
	Limit   int
}

// BoardListFilter is a normalized forward run page scoped to one board.
type BoardListFilter struct {
	BoardID uuid.UUID
	AgentID uuid.UUID
	Status  Status
	After   *Cursor
	Limit   int
}

// AdmitParams contains all values for assignment, run, and sequence-zero event.
type AdmitParams struct {
	RunID          uuid.UUID
	CreatedEventID uuid.UUID
	AssignmentID   uuid.UUID
	IssueRef       string
	WorkspaceID    uuid.UUID
	AgentID        *uuid.UUID
	Instructions   *string
	RequestedBy    uuid.UUID
	RequestID      string
	TraceParent    string
	CreatedAt      time.Time
}

// Dispatch contains the durable context required by one unsafe POST.
type Dispatch struct {
	RunID            uuid.UUID
	IssueID          uuid.UUID
	BoardID          uuid.UUID
	AgentID          uuid.UUID
	UpstreamAgentID  uuid.UUID
	IssueIdentifier  string
	IssueTitle       string
	IssueDescription *string
	Instructions     *string
	// Repository the issue's project delivers into, as owner/name. Empty when
	// the issue belongs to no project, or its project names no repository.
	Repository string
	// WorkspaceID is needed to open the credential that reads the repository.
	WorkspaceID uuid.UUID
	// CodeContext is the rendered repository context, filled in by the
	// dispatcher rather than the query: building it costs upstream calls, and a
	// claim that never dispatches should not pay for them.
	CodeContext string
	// PriorWork is what the tasks this issue depends on produced, filled in by
	// the dispatcher for the same reason as CodeContext: it costs storage
	// reads.
	PriorWork   string
	RequestID   string
	TraceParent string
}

// CancellationClaim serializes stop intent and proves whether this caller owns
// the one allowed upstream stop attempt.
type CancellationClaim struct {
	Run             Run
	UpstreamAgentID uuid.UUID
	ShouldStop      bool
	CancelLocally   bool
}

// SuccessParams commits usage, terminal run state, and the human review gate.
type SuccessParams struct {
	RunID            uuid.UUID
	UsageEventID     uuid.UUID
	CompletedEventID uuid.UUID
	IssueEventID     uuid.UUID
	Usage            Usage
	Summary          *string
	CompletedAt      time.Time
}

// FailParams commits one safe terminal failure and optional reconciliation flag.
type FailParams struct {
	RunID     uuid.UUID
	EventID   uuid.UUID
	Failure   Failure
	FailedAt  time.Time
	Reconcile bool
}

// CancelParams records authenticated cancellation intent.
type CancelParams struct {
	RunID       uuid.UUID
	RequestedBy uuid.UUID
	RequestedAt time.Time
}

var (
	ErrNotFound                = errors.New("run resource not found")
	ErrIssueHasNoAgent         = errors.New("issue has no agent assignee")
	ErrAgentNotFound           = errors.New("agent not found")
	ErrConflict                = errors.New("run state conflict")
	ErrDispatchAlreadyClaimed  = errors.New("run dispatch already claimed")
	ErrRunTerminal             = errors.New("run is terminal")
	ErrRunCancelling           = errors.New("run cancellation is in progress")
	ErrCancellationUnconfirmed = errors.New("runtime cancellation was not confirmed")
	ErrCursorExpired           = ledger.ErrCursorExpired
)

// ActiveRunError identifies the active run that blocked admission.
type ActiveRunError struct {
	RunID uuid.UUID
}

func (err *ActiveRunError) Error() string {
	return "an active run already exists"
}

func (err *ActiveRunError) Unwrap() error {
	return ErrConflict
}
