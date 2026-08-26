// Package orchestration holds Berry's Temporal workflows and activities
// (ADR-0005).
//
// Naming: OpenFang exposes its own `workflows` API, and Berry must not reuse
// OpenFang-derived identifiers. Nothing in this package is called `workflow`.
// The Temporal executions are `RunOrchestration` and `IntakeOrchestration`.
//
// Ownership: Temporal executes, it does not remember. PostgreSQL stays
// authoritative for the run ledger and every API read; Temporal history is
// operational evidence only. Deleting the namespace must not lose product
// state.
package orchestration

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// TaskQueue is the default queue both the API (as client) and the worker use.
// Overridden by TEMPORAL_TASK_QUEUE.
const TaskQueue = "berry-runs"

// Workflow type names. These are persisted in Temporal history, so renaming
// one strands in-flight executions — treat them as a wire contract.
const (
	RunOrchestrationName    = "berry.RunOrchestration"
	IntakeOrchestrationName = "berry.IntakeOrchestration"
)

// Signal names accepted by RunOrchestration.
const (
	// CancelRunSignal carries a cancellation request from the HTTP layer. The
	// workflow owns the single permitted upstream stop call, so cancellation
	// survives an API restart instead of racing an in-process goroutine.
	CancelRunSignal = "berry.CancelRun"
)

// RunWorkflowID derives the deduplication key for one run. Admission already
// guarantees at most one active run per issue; this makes a duplicate *start*
// a no-op at the Temporal layer too, so a retried caller cannot produce two
// orchestrations for one ledger row.
func RunWorkflowID(runID string) string {
	return "run:" + runID
}

// Timeouts. DispatchStreamTimeout bounds one agent execution end to end: the
// SSE client closes a stream still open past it, and the run becomes
// STREAM_TIMEOUT and reconcilable rather than hanging a worker slot forever.
//
// The Temporal bounds sit above it on purpose. The activity context carries
// its StartToClose deadline from the moment the activity starts, and the SSE
// client derives its own deadline from that context a little later, so two
// equal bounds would expire in the wrong order: Temporal would time the
// activity out first, RunOrchestration would return that failure, and the
// artifact promotion and delivery after the dispatch would never run. With
// the gap, the client's close ends the stream, the activity records the
// timeout in the ledger and returns normally, and the orchestration carries
// on. RunOrchestrationTimeout then covers the dispatch and every activity
// after it.
const (
	DispatchStreamTimeout   = 2 * time.Hour
	DispatchActivityTimeout = DispatchStreamTimeout + 5*time.Minute
	RunOrchestrationTimeout = DispatchActivityTimeout + 10*time.Minute
	DispatchHeartbeat       = 30 * time.Second
	LedgerActivityTimeout   = 30 * time.Second
	IntakeActivityTimeout   = time.Minute
)

// CancelRequest is the CancelRunSignal payload.
type CancelRequest struct {
	RequestedBy string `json:"requestedBy"`
}

// IntakeParams configures the intake loop. Carried as workflow input so the
// values in force are visible in history, and so a change takes effect at the
// next continue-as-new rather than mid-execution, which would break replay.
type IntakeParams struct {
	BatchSize     int           `json:"batchSize"`
	MaxConcurrent int           `json:"maxConcurrent"`
	Interval      time.Duration `json:"interval"`
}

// IntakeResult reports what a tick did, for logging and tests.
type IntakeResult struct {
	Considered int      `json:"considered"`
	Admitted   int      `json:"admitted"`
	Skipped    int      `json:"skipped"`
	RunIDs     []string `json:"runIds"`
	// Routed counts issues the orchestrator assigned by capability match, and
	// Fallback counts those it took itself for want of any other agent. Both
	// are surfaced because an automatic assignment nobody can account for is
	// worse than no automatic assignment.
	Routed   int `json:"routed"`
	Fallback int `json:"fallback"`
}

// Automation orchestration names. The product noun is Workflow and the Go
// noun automation (ADR-0007); like the run names above these persist in
// Temporal history, so they are a wire contract.
const (
	AutomationOrchestrationName = "berry.AutomationOrchestration"
	// AutomationResumeSignal carries the fact a parked run waited on: an
	// approval decided, an agent run ended, an issue completed, an event a
	// step subscribed to, or a timer the dispatcher claimed.
	AutomationResumeSignal = "berry.AutomationResume"
	// AutomationCancelSignal tells a waiting orchestration that the run row
	// was cancelled from the HTTP layer, so it stops waiting for a resume
	// that will never come.
	AutomationCancelSignal = "berry.AutomationCancel"
)

// AutomationRunWorkflowID derives the deduplication key for one workflow
// run. The run row is created idempotently on its source event before the
// orchestration starts, and this makes a duplicate start a no-op at the
// Temporal layer too.
func AutomationRunWorkflowID(runID uuid.UUID) string {
	return "automation-run:" + runID.String()
}

// AutomationScheduleID names the Temporal Schedule that fires a
// schedule-triggered workflow. Schedules themselves land with the schedule
// trigger (P4.5); the id is fixed here so the seam and the worker agree.
func AutomationScheduleID(automationID uuid.UUID) string {
	return "automation-schedule:" + automationID.String()
}

// Automation bounds. A step activity walks a run until it finishes or parks;
// the run timeout covers the longest a run may stay parked on a person.
const (
	AutomationActivityTimeout = 30 * time.Minute
	AutomationHeartbeat       = 30 * time.Second
	AutomationRunTimeout      = 30 * 24 * time.Hour
)

// AutomationResume is the AutomationResumeSignal payload: one settled wait,
// in the vocabulary automation_runs.waiting_on stores.
type AutomationResume struct {
	Kind       string          `json:"kind"`
	ID         string          `json:"id,omitempty"`
	Topic      string          `json:"topic,omitempty"`
	Outcome    string          `json:"outcome,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	OccurredAt time.Time       `json:"occurredAt"`
}

// AutomationCancel is the AutomationCancelSignal payload.
type AutomationCancel struct {
	RequestedBy string `json:"requestedBy"`
}

// AutomationRunState is what a step activity reports back: whether the run
// finished, and if not what it waits on.
type AutomationRunState struct {
	Status    string `json:"status"`
	WaitingOn string `json:"waitingOn,omitempty"`
	Terminal  bool   `json:"terminal"`
}
