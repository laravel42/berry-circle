package orchestration

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/artifacts"
)

// ArtifactPromoter moves a finished run's output into Berry's store.
type ArtifactPromoter interface {
	Enabled() bool
	Promote(context.Context, artifacts.RunContext) (artifacts.Result, error)
}

// PromotableRun is what the promoter needs to know about a finished run.
type PromotableRun struct {
	AgentSlug   string
	StartedAt   time.Time
	CompletedAt time.Time
	Succeeded   bool
}

// RunArtifactSource resolves a run to the workspace that holds its output.
type RunArtifactSource interface {
	PromotableRun(context.Context, uuid.UUID) (PromotableRun, error)
}

// PromoteRunArtifacts publishes the files a finished run produced (ADR-0006).
//
// Deliberately a separate activity from dispatch rather than a step inside it.
// The work is already done and recorded by the time this runs, so a promotion
// that fails must not roll back or re-attempt the run itself — it is the
// difference between losing a file and repeating a paid model call.
func (activities *Activities) PromoteRunArtifacts(ctx context.Context, runID string) error {
	if activities.Artifacts == nil || !activities.Artifacts.Enabled() {
		return nil
	}
	if activities.ArtifactRuns == nil {
		return errors.New("orchestration artifact source is nil")
	}
	id, err := uuid.Parse(runID)
	if err != nil {
		return errors.New("orchestration run id is invalid")
	}

	run, err := activities.ArtifactRuns.PromotableRun(ctx, id)
	if err != nil {
		return err
	}
	// Only a successful run offers artifacts. A failed or cancelled one may
	// have left half-written files, and attaching those to an issue would
	// present an abandoned draft as a deliverable.
	if !run.Succeeded {
		return nil
	}

	_, err = activities.Artifacts.Promote(ctx, artifacts.RunContext{
		RunID:       id,
		AgentSlug:   run.AgentSlug,
		StartedAt:   run.StartedAt,
		CompletedAt: run.CompletedAt,
	})
	return err
}
