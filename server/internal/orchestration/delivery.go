package orchestration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/artifacts"
	"github.com/laravel42/berry-circle/server/internal/delivery"
	"github.com/laravel42/berry-circle/server/internal/integrations/github"

	"go.temporal.io/sdk/temporal"
)

// RunDelivery publishes a finished run's output as a pull request.
type RunDelivery interface {
	Deliver(ctx context.Context, run delivery.Run, window artifacts.RunContext) (string, error)
}

// DeliverableRun is what delivery needs to know about a finished run.
type DeliverableRun struct {
	WorkspaceID     uuid.UUID
	Repository      string
	AgentSlug       string
	IssueIdentifier string
	IssueTitle      string
	StartedAt       time.Time
	CompletedAt     time.Time
	Succeeded       bool
}

// DeliverableRuns resolves a run to what delivery needs.
type DeliverableRuns interface {
	DeliverableRun(context.Context, uuid.UUID) (DeliverableRun, error)
}

// DeliverRunOutput opens a pull request for what a run produced.
//
// A separate activity from promotion, and after it, because the two answer
// different questions about the same files: promotion asks whether Berry should
// keep them, delivery asks whether they belong in the repository. A run whose
// artifacts were stored but whose pull request failed has still kept the work.
func (activities *Activities) DeliverRunOutput(ctx context.Context, runID string) error {
	if activities.Delivery == nil || activities.DeliverableRuns == nil {
		return nil
	}
	id, err := uuid.Parse(runID)
	if err != nil {
		return errors.New("orchestration run id is invalid")
	}
	run, err := activities.DeliverableRuns.DeliverableRun(ctx, id)
	if err != nil {
		return err
	}
	// Only successful runs deliver. A failed one may have written a partial
	// file, and a pull request is a claim that the work is ready to look at.
	if !run.Succeeded || run.Repository == "" {
		return nil
	}

	url, err := activities.Delivery.Deliver(ctx,
		delivery.Run{
			RunID:           id,
			WorkspaceID:     run.WorkspaceID,
			Repository:      run.Repository,
			AgentSlug:       run.AgentSlug,
			IssueIdentifier: run.IssueIdentifier,
			IssueTitle:      run.IssueTitle,
		},
		artifacts.RunContext{
			RunID:       id,
			AgentSlug:   run.AgentSlug,
			StartedAt:   run.StartedAt,
			CompletedAt: run.CompletedAt,
		})
	if errors.Is(err, delivery.ErrNothingProduced) {
		// The common case for an agent that answered in prose. Not a fault, and
		// not worth failing a run that otherwise succeeded.
		return nil
	}
	if errors.Is(err, github.ErrUnauthorized) {
		// The token cannot write to this repository, and it will not be able to
		// on the fifth attempt either. Retrying uploads the same blobs four more
		// times and buries the one line that says what to fix.
		if activities.Logger != nil {
			activities.Logger.Warn(
				"delivery refused: the GitHub connection cannot write to this repository",
				"runId", id, "repository", run.Repository)
		}
		return temporal.NewNonRetryableApplicationError(
			"the GitHub connection cannot write to "+run.Repository,
			"github_write_forbidden", err)
	}
	if err != nil {
		return err
	}
	if url != "" && activities.Logger != nil {
		activities.Logger.Info("opened a pull request for a run", "runId", id, "url", url)
	}
	return nil
}
