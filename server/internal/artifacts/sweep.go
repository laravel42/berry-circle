package artifacts

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// sweepWindow bounds how far back a recovery pass looks. Long enough to cover a
// worker that was down overnight, short enough that a start does not walk the
// whole history.
const sweepWindow = 24 * time.Hour

// sweepLimit bounds how many runs one pass will reconsider.
const sweepLimit = 50

// PendingSource finds runs whose output was never published.
type PendingSource interface {
	RunsAwaitingPromotion(context.Context, time.Time, int) ([]uuid.UUID, error)
	PromotableRunContext(context.Context, uuid.UUID) (RunContext, bool, error)
}

// Recover promotes the output of recent successful runs that have none.
//
// Promotion normally happens as a run finishes, so a run whose promotion never
// ran has no other route: each run only claims files from its own window, and
// no later run will ever pick them up. That leaves output orphaned in the
// runtime's scratch space after a worker restart, a brief storage outage, or —
// as here — a run that predates the feature.
//
// Safe to repeat. Reserving is per-run and per-filename, so a run whose files
// were already published is skipped, and a file outside a run's window is not
// claimed by it just because this pass is running later.
func Recover(
	ctx context.Context,
	promoter *Promoter,
	source PendingSource,
	now time.Time,
	logger *slog.Logger,
) (int, error) {
	if promoter == nil || !promoter.Enabled() || source == nil {
		return 0, nil
	}
	if logger == nil {
		logger = slog.Default()
	}

	pending, err := source.RunsAwaitingPromotion(ctx, now.Add(-sweepWindow), sweepLimit)
	if err != nil {
		return 0, err
	}

	recovered := 0
	for _, runID := range pending {
		run, ok, err := source.PromotableRunContext(ctx, runID)
		if err != nil {
			logger.Warn("could not resolve a run for artifact recovery",
				"runId", runID, "error", err)
			continue
		}
		if !ok {
			continue
		}
		result, err := promoter.Promote(ctx, run)
		if err != nil {
			// One unreadable workspace must not stop the rest.
			logger.Warn("artifact recovery failed for a run", "runId", runID, "error", err)
			continue
		}
		if len(result.Promoted) > 0 {
			logger.Info("recovered artifacts from an earlier run",
				"runId", runID, "files", result.Promoted)
			recovered += len(result.Promoted)
		}
	}
	return recovered, nil
}
