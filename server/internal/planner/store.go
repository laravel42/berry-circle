package planner

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/repository/ledger"
	"github.com/laravel42/berry-circle/server/internal/repository/plans"
)

// Store is the generated-plan persistence the pipeline writes through. The
// plans repository satisfies it; tests use a memory implementation.
type Store interface {
	CreateGenerated(context.Context, plans.CreateGeneratedParams) (plans.PlanHeader, []ledger.Event, error)
	GetHeader(context.Context, uuid.UUID) (plans.PlanHeader, error)
	SaveVersion(context.Context, plans.SaveVersionParams) (plans.PlanVersion, error)
	FinishGeneration(context.Context, plans.FinishGenerationParams) error
	RecordEvent(context.Context, plans.RecordEventParams) (plans.PlannerEvent, error)
	EmitPlanEvent(context.Context, uuid.UUID, string, map[string]any, func() uuid.UUID, time.Time) (ledger.Event, error)
	DefaultBoard(context.Context, uuid.UUID) (uuid.UUID, error)
}
