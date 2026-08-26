package automationrun

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// SignalKind names what a parked run resumes on.
type SignalKind string

const (
	SignalApproval SignalKind = "approval"
	SignalRun      SignalKind = "run"
	SignalIssue    SignalKind = "issue"
	SignalEvent    SignalKind = "event"
	SignalTimer    SignalKind = "timer"
)

// ResumeSignal is one fact that settles a wait: the approval that was
// decided, the agent run that ended, the issue that completed, the event a
// step subscribed to, or the timer that elapsed. Outcome is the fact's
// verb (approved, rejected, expired, completed, failed, cancelled, deleted)
// and Payload the fact's own payload, kept for the step's output.
type ResumeSignal struct {
	Kind       SignalKind
	ID         uuid.UUID
	Topic      string
	Outcome    string
	Payload    json.RawMessage
	OccurredAt time.Time
}

// Key is the wait key the signal answers, in the vocabulary
// automation_runs.waiting_on stores.
func (signal ResumeSignal) Key() string {
	switch signal.Kind {
	case SignalApproval:
		return "approval:" + signal.ID.String()
	case SignalRun:
		return "run:" + signal.ID.String()
	case SignalIssue:
		return "issue:" + signal.ID.String()
	case SignalEvent:
		return "event:" + signal.Topic
	case SignalTimer:
		return "timer"
	}
	return ""
}

// WaitKeys lists the wait keys an outbox topic can settle, and the signal
// each one carries. An aggregate wildcard wait ("event:issue.*") is settled
// by any topic of that aggregate.
func WaitKeys(topic string, aggregateID uuid.UUID, payload json.RawMessage, occurredAt time.Time) []ResumeSignal {
	base := ResumeSignal{ID: aggregateID, Topic: topic, Payload: payload, OccurredAt: occurredAt}
	var signals []ResumeSignal
	switch topic {
	case "approval.approved":
		signals = append(signals, with(base, SignalApproval, "approved"))
	case "approval.rejected":
		signals = append(signals, with(base, SignalApproval, "rejected"))
	case "approval.expired":
		signals = append(signals, with(base, SignalApproval, "expired"))
	case "run.completed":
		signals = append(signals, with(base, SignalRun, "completed"))
	case "run.failed":
		signals = append(signals, with(base, SignalRun, "failed"))
	case "run.cancelled":
		signals = append(signals, with(base, SignalRun, "cancelled"))
	case "issue.completed":
		signals = append(signals, with(base, SignalIssue, "completed"))
	case "issue.deleted":
		signals = append(signals, with(base, SignalIssue, "deleted"))
	// A subworkflow step waits on its child run under the same run:<id>
	// key an issue-mode agent step uses; the step type tells them apart.
	case "workflow.run.succeeded":
		signals = append(signals, with(base, SignalRun, "completed"))
	case "workflow.run.failed":
		signals = append(signals, with(base, SignalRun, "failed"))
	case "workflow.run.cancelled":
		signals = append(signals, with(base, SignalRun, "cancelled"))
	}
	signals = append(signals, with(base, SignalEvent, topic))
	return signals
}

func with(base ResumeSignal, kind SignalKind, outcome string) ResumeSignal {
	base.Kind = kind
	base.Outcome = outcome
	return base
}
