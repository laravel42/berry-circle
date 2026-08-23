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

import "time"

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

// Timeouts. DispatchStreamTimeout bounds one agent execution end to end; an
// agent that streams for longer than this is treated as stuck, and the run
// becomes reconcilable rather than hanging a worker slot forever.
const (
	DispatchStreamTimeout = 2 * time.Hour
	DispatchHeartbeat     = 30 * time.Second
	LedgerActivityTimeout = 30 * time.Second
	IntakeActivityTimeout = time.Minute
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
