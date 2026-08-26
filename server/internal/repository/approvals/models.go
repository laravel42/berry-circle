// Package approvals owns every "ask me first" moment: a plan waiting for
// Start Plan, an issue that may not start before a person says so, a
// workflow activation or step gated on a decision. One table, one lifecycle,
// so nothing can begin on the strength of a check somebody forgot.
package approvals

import (
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/core"
	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
)

var (
	// ErrNotFound hides absent and cross-workspace approvals behind one result.
	ErrNotFound = errors.New("approval not found")
	// ErrAlreadyResolved means the approval left pending before this decision.
	ErrAlreadyResolved = errors.New("approval already resolved")
	// ErrConflict is a uniqueness conflict, such as a second pending gate on
	// the same issue.
	ErrConflict = errors.New("approval conflict")
	// ErrApprovalRequired surfaces when releasing an issue hits another gate
	// (the 010 plan gate). It is the core error so one handler branch covers
	// both sources.
	ErrApprovalRequired = core.ErrApprovalRequired
)

// Kind is what the approval gates.
type Kind string

const (
	KindPlan                 Kind = "plan"
	KindIssueStart           Kind = "issue_start"
	KindAutomationActivation Kind = "automation_activation"
	KindAutomationStep       Kind = "automation_step"
	KindIntegrationAction    Kind = "integration_action"
)

// Valid reports whether the kind is persisted by the schema.
func (kind Kind) Valid() bool {
	switch kind {
	case KindPlan, KindIssueStart, KindAutomationActivation, KindAutomationStep, KindIntegrationAction:
		return true
	}
	return false
}

// Risk is what a wrong decision could cost.
type Risk string

const (
	RiskLow    Risk = "low"
	RiskMedium Risk = "medium"
	RiskHigh   Risk = "high"
)

// Status is the approval lifecycle.
type Status string

const (
	StatusPending  Status = "pending"
	StatusApproved Status = "approved"
	StatusRejected Status = "rejected"
	StatusExpired  Status = "expired"
)

// Decision is what a person can do to a pending approval.
type Decision string

const (
	DecisionApproved Decision = "approved"
	DecisionRejected Decision = "rejected"
)

// ActorType names who asked.
type ActorType string

const (
	ActorUser   ActorType = "user"
	ActorSystem ActorType = "system"
	ActorAgent  ActorType = "agent"
)

// IssueRef names the gated issue for readers.
type IssueRef struct {
	ID         uuid.UUID
	Identifier string
	Title      string
}

// Approval is a storage-neutral approval record.
type Approval struct {
	ID                  uuid.UUID
	WorkspaceID         uuid.UUID
	Kind                Kind
	Risk                Risk
	Title               string
	Description         *string
	GoalID              *uuid.UUID
	PlanID              *uuid.UUID
	IssueID             *uuid.UUID
	Issue               *IssueRef
	AutomationID        *uuid.UUID
	AutomationRunID     *uuid.UUID
	AutomationStepRunID *uuid.UUID
	AuditEventID        *uuid.UUID
	RequestedFromUserID *uuid.UUID
	RequestedFromRole   string
	RequestedByType     ActorType
	RequestedBy         *uuid.UUID
	Status              Status
	DecisionNote        *string
	ResolvedBy          *uuid.UUID
	RequestedAt         time.Time
	ExpiresAt           *time.Time
	ResolvedAt          *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

// Pending reports whether a decision is still open.
func (approval Approval) Pending() bool {
	return approval.Status == StatusPending
}

// Cursor is the stable (requestedAt, id) descending list key.
type Cursor struct {
	RequestedAt time.Time `json:"requestedAt"`
	ID          uuid.UUID `json:"id"`
}

// ListFilter narrows a workspace listing.
type ListFilter struct {
	Status       Status
	Kind         Kind
	GoalID       *uuid.UUID
	IssueID      *uuid.UUID
	AutomationID *uuid.UUID
}

// CreateParams is one approval request. Exactly one addressee form is
// required: a user, or a role any member of that rank may act for.
type CreateParams struct {
	ID                  uuid.UUID
	WorkspaceID         uuid.UUID
	Kind                Kind
	Risk                Risk
	Title               string
	Description         *string
	GoalID              *uuid.UUID
	PlanID              *uuid.UUID
	IssueID             *uuid.UUID
	AutomationID        *uuid.UUID
	AutomationRunID     *uuid.UUID
	AutomationStepRunID *uuid.UUID
	AuditEventID        *uuid.UUID
	RequestedFromUserID *uuid.UUID
	RequestedFromRole   string
	RequestedByType     ActorType
	RequestedBy         *uuid.UUID
	RequestedAt         time.Time
	ExpiresAt           *time.Time
	// NewID mints the outbox event id; nil falls back to a random id.
	NewID func() uuid.UUID
}

// Resolution is one decision.
type Resolution struct {
	Decision Decision
	Note     string
	ActorID  uuid.UUID
	Now      time.Time
	// NewID mints the outbox event ids; nil falls back to random ids.
	NewID func() uuid.UUID
}

// Event is the durable outbox fact a mutation returns for live publication.
type Event = ledger.Event
