package automation

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// StepStatus is what one execution attempt of a step produced.
type StepStatus string

const (
	StepSucceeded StepStatus = "succeeded"
	StepWaiting   StepStatus = "waiting"
	StepSkipped   StepStatus = "skipped"
)

// Usage is the model usage an inline agent step spent, recorded on the step
// run and summed on the run so no paid call is invisible.
type Usage struct {
	InputTokens       int64  `json:"inputTokens"`
	OutputTokens      int64  `json:"outputTokens"`
	CostMicros        *int64 `json:"costMicros,omitempty"`
	Currency          string `json:"currency,omitempty"`
	UpstreamRequestID string `json:"upstreamRequestId,omitempty"`
}

// StepContext is what an executor receives: the run it belongs to, the step
// to execute, and the scope its references resolve against.
type StepContext struct {
	WorkspaceID  uuid.UUID
	AutomationID uuid.UUID
	RunID        uuid.UUID
	StepRunID    uuid.UUID
	Step         Step
	Scope        Scope
	// RequestedBy is the person the run acts on behalf of (the workflow's
	// creator for triggered runs), used for authorisation and provenance.
	RequestedBy uuid.UUID
	// GoalID is the goal the run serves, when the workflow has one.
	GoalID *uuid.UUID
	// Approved is set when the step resumes after a person approved it: an
	// action that needed a decision now runs instead of asking again.
	Approved bool
	// ApprovalID is the decision the step resumed on, when Approved.
	ApprovalID *uuid.UUID
	Now        time.Time
}

// StepLinks are the rows a step produced or waits through, recorded on the
// step run so a reader can follow a step to its issue, run or approval.
type StepLinks struct {
	IssueID      *uuid.UUID
	IssueRunID   *uuid.UUID
	ApprovalID   *uuid.UUID
	AuditEventID *uuid.UUID
}

// StepOutcome is what an executor returns. A waiting outcome names what the
// run waits on ("approval:<id>", "run:<id>", "issue:<id>", "timer",
// "event:<topic>") and, for timers, when to resume.
type StepOutcome struct {
	Status    StepStatus
	Output    json.RawMessage
	WaitingOn string
	ResumeAt  *time.Time
	// Next overrides the default successors (condition branches).
	Next  []string
	Usage *Usage
	Links StepLinks
}

// StepExecutor runs one node type natively. Executors land with native
// execution (P1b); the seam is defined here so the runner and the validator
// agree on the vocabulary.
type StepExecutor interface {
	Execute(ctx context.Context, step StepContext) (StepOutcome, error)
}
