package orchestration

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/autogate"
)

// AutoReviewer judges a finished run on a peer agent's behalf.
type AutoReviewer interface {
	Review(ctx context.Context, runID uuid.UUID) (autogate.Verdict, error)
}

// AutoReviewRunOutput closes an auto-gated issue when a peer approves it.
//
// Last in the run workflow, after promotion and delivery, because the reviewer
// is shown what those produced: a verdict passed on work whose artifacts had
// not been stored yet would be a verdict on the summary alone.
//
// Every failure leaves the issue in review, which is where it would have been
// without AutoGate. That is the safe direction: a review that could not happen
// must never read as one that passed.
func (activities *Activities) AutoReviewRunOutput(ctx context.Context, runID string) error {
	if activities.AutoReview == nil {
		return nil
	}
	id, err := uuid.Parse(runID)
	if err != nil {
		return errors.New("orchestration run id is invalid")
	}
	verdict, err := activities.AutoReview.Review(ctx, id)
	switch {
	case errors.Is(err, autogate.ErrNotGated):
		// The ordinary case: this plan asks a person to look.
		return nil
	case errors.Is(err, autogate.ErrNoReviewer):
		if activities.Logger != nil {
			activities.Logger.Info(
				"auto review skipped: no peer agent was free, the issue waits for a person",
				"runId", id)
		}
		return nil
	case err != nil:
		return err
	}
	if activities.Logger != nil {
		activities.Logger.Info("auto review complete",
			"runId", id, "approved", verdict.Approved)
	}
	return nil
}
