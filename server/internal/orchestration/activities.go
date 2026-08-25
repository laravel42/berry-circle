package orchestration

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/activity"

	"github.com/laravel42/berry-circle/server/internal/repository/intake"
	"github.com/laravel42/berry-circle/server/internal/repository/runs"
)

// IntakeStore is the selection seam. Implemented by *intake.Repository.
type IntakeStore interface {
	ActiveRuns(context.Context) (int, error)
	Candidates(context.Context, int) ([]intake.Candidate, error)
	MarkInProgress(context.Context, uuid.UUID, uuid.UUID) error
}

// RunDispatcher is the durable run seam. Implemented by
// *runadmission.Service, so Temporal and the in-process pool share one
// projection implementation and cannot drift.
type RunDispatcher interface {
	Admit(context.Context, runs.AdmitParams) (runs.Run, error)
	Execute(context.Context, uuid.UUID)
	Cancel(context.Context, uuid.UUID, uuid.UUID) (runs.Run, error)
}

// Activities carries every external dependency explicitly, matching the
// constructor style used elsewhere in the server.
type Activities struct {
	Intake IntakeStore
	Runs   RunDispatcher
	// ActorID attributes automated runs to a real Berry identity. runs.requested_by
	// is a foreign key to users(id), and an audit trail that cannot name who
	// started a run is not an audit trail.
	ActorID uuid.UUID
	Clock   func() time.Time
	NewID   func() uuid.UUID
	// Artifacts and ArtifactRuns publish what a run produced. Both optional:
	// a deployment without the runtime volume mounted simply does not promote,
	// which is what it did before ADR-0006 rather than a failure.
	Artifacts    ArtifactPromoter
	ArtifactRuns RunArtifactSource
}

// NewActivities validates dependencies up front so a misconfigured worker
// fails at startup rather than on the first tick.
func NewActivities(activities Activities) (*Activities, error) {
	switch {
	case activities.Intake == nil:
		return nil, errors.New("orchestration intake store is nil")
	case activities.Runs == nil:
		return nil, errors.New("orchestration run dispatcher is nil")
	case activities.ActorID == uuid.Nil:
		return nil, errors.New("orchestration actor ID is nil")
	}
	if activities.Clock == nil {
		activities.Clock = time.Now
	}
	if activities.NewID == nil {
		activities.NewID = uuid.New
	}
	return &activities, nil
}

// ClaimIntakeBatch selects ready work and durably admits a run for each.
//
// Admission is the authority: a candidate that lost a race returns
// *runs.ActiveRunError, which is a skip and not a failure. Errors that mean
// "this issue is not dispatchable" (no agent, agent archived) are likewise
// skipped, so one bad row cannot stall the whole intake loop.
//
// The activity is safe to retry. It creates runs, but every creation is
// guarded by the durable one-active-run-per-issue constraint, so a retry after
// an ambiguous failure re-selects only work that was genuinely not admitted.
func (activities *Activities) ClaimIntakeBatch(
	ctx context.Context,
	params IntakeParams,
) (IntakeResult, error) {
	result := IntakeResult{RunIDs: []string{}}
	if params.BatchSize < 1 || params.MaxConcurrent < 1 {
		return result, errors.New("intake parameters are invalid")
	}

	active, err := activities.Intake.ActiveRuns(ctx)
	if err != nil {
		return result, err
	}
	// The cap bounds concurrent provider spend, so it is enforced before any
	// run is created rather than after.
	budget := params.MaxConcurrent - active
	if budget <= 0 {
		return result, nil
	}
	if budget > params.BatchSize {
		budget = params.BatchSize
	}

	candidates, err := activities.Intake.Candidates(ctx, budget)
	if err != nil {
		return result, err
	}
	result.Considered = len(candidates)

	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		activity.RecordHeartbeat(ctx, result.Admitted)

		agentID := candidate.AgentID
		run, err := activities.Runs.Admit(ctx, runs.AdmitParams{
			RunID:          activities.NewID(),
			CreatedEventID: activities.NewID(),
			AssignmentID:   activities.NewID(),
			IssueRef:       candidate.IssueID.String(),
			WorkspaceID:    candidate.WorkspaceID,
			AgentID:        &agentID,
			RequestedBy:    activities.ActorID,
			RequestID:      "intake:" + candidate.IssueID.String(),
			CreatedAt:      activities.Clock().UTC(),
		})
		if err != nil {
			if skippableAdmission(err) {
				result.Skipped++
				continue
			}
			return result, fmt.Errorf("admit intake candidate: %w", err)
		}

		// Best effort: the run is already durable, and a terminal transition
		// will correct the board regardless.
		_ = activities.Intake.MarkInProgress(ctx, candidate.IssueID, run.ID)

		switch candidate.Routing {
		case intake.RoutingRouted:
			result.Routed++
		case intake.RoutingFallback:
			result.Fallback++
		}
		activity.GetLogger(ctx).Info(
			"intake dispatched issue",
			"runId", run.ID,
			"issueId", candidate.IssueID,
			"agentId", candidate.AgentID,
			"routing", candidate.Routing,
			"capabilityMatches", candidate.CapabilityMatches,
		)

		result.Admitted++
		result.RunIDs = append(result.RunIDs, run.ID.String())
	}
	return result, nil
}

// skippableAdmission reports whether a candidate simply is not dispatchable
// right now. These are expected outcomes of optimistic selection, not faults.
func skippableAdmission(err error) bool {
	var active *runs.ActiveRunError
	if errors.As(err, &active) {
		return true
	}
	return errors.Is(err, runs.ErrIssueHasNoAgent) ||
		errors.Is(err, runs.ErrAgentNotFound) ||
		errors.Is(err, runs.ErrNotFound) ||
		errors.Is(err, runs.ErrConflict)
}

// DispatchRun performs the one permitted upstream dispatch and consumes the
// stream to a terminal ledger state.
//
// THIS ACTIVITY MUST NEVER BE RETRIED. POST /api/agents/{id}/message/stream is
// classified RetryUnsafe upstream and is attempted exactly once; a retry would
// run the agent twice, duplicating paid execution and tool side effects, and
// would violate the pinned OpenFang contract. The retry policy is pinned to
// MaximumAttempts: 1 in run.go and asserted in activities_test.go.
//
// It returns nil even when the run fails. Every failure path inside Execute
// commits a terminal or reconcilable ledger row, and the ledger is
// authoritative — surfacing an error here would only invite someone to make
// it retryable.
func (activities *Activities) DispatchRun(ctx context.Context, runID string) error {
	parsed, err := uuid.Parse(runID)
	if err != nil {
		return fmt.Errorf("dispatch run id: %w", err)
	}

	// Heartbeat while the stream is consumed so a dead worker is detected as a
	// heartbeat timeout, which the workflow turns into a reconciliation marker
	// rather than an orphaned row.
	beat, stopBeat := context.WithCancel(ctx)
	defer stopBeat()
	go func() {
		ticker := time.NewTicker(DispatchHeartbeat / 2)
		defer ticker.Stop()
		for {
			select {
			case <-beat.Done():
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx, runID)
			}
		}
	}()

	activities.Runs.Execute(ctx, parsed)
	return nil
}

// CancelRun records cancellation intent and makes the one allowed upstream
// stop call. Safe to retry: the durable claim in RequestCancellation decides
// which caller owns that single attempt.
func (activities *Activities) CancelRun(
	ctx context.Context,
	runID string,
	requestedBy string,
) error {
	parsedRun, err := uuid.Parse(runID)
	if err != nil {
		return fmt.Errorf("cancel run id: %w", err)
	}
	actor := activities.ActorID
	if requestedBy != "" {
		if parsed, err := uuid.Parse(requestedBy); err == nil {
			actor = parsed
		}
	}
	if _, err := activities.Runs.Cancel(ctx, parsedRun, actor); err != nil {
		if errors.Is(err, runs.ErrRunTerminal) || errors.Is(err, runs.ErrNotFound) {
			return nil
		}
		return err
	}
	return nil
}
