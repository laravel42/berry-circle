package p2

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
)

type ProjectionStore interface {
	ProjectInboxBatch(
		context.Context,
		func() uuid.UUID,
		func() time.Time,
		int,
	) (p2repo.ProjectionResult, error)
}

type ProjectorOptions struct {
	Store ProjectionStore
	Clock func() time.Time
	NewID func() uuid.UUID
}

// Projector consumes durable outbox rows. Its only checkpoint is the
// inbox_projection_events table written atomically with each inbox projection.
type Projector struct {
	store ProjectionStore
	clock func() time.Time
	newID func() uuid.UUID
}

func NewProjector(options ProjectorOptions) (*Projector, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("inbox projector store is nil")
	case options.Clock == nil:
		return nil, errors.New("inbox projector clock is nil")
	case options.NewID == nil:
		return nil, errors.New("inbox projector ID generator is nil")
	}
	return &Projector{
		store: options.Store,
		clock: options.Clock,
		newID: options.NewID,
	}, nil
}

func (projector *Projector) RunOnce(
	ctx context.Context,
	limit int,
) (p2repo.ProjectionResult, error) {
	return projector.store.ProjectInboxBatch(ctx, projector.newID, projector.clock, limit)
}

// Run polls only for wakeups. PostgreSQL outbox rows and projection receipts,
// rather than this loop, remain the source of truth across restarts.
func (projector *Projector) Run(
	ctx context.Context,
	pollInterval time.Duration,
	batchSize int,
) error {
	if pollInterval <= 0 || batchSize < 1 || batchSize > 500 {
		return errors.New("invalid inbox projector run options")
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		result, err := projector.RunOnce(ctx, batchSize)
		if err != nil {
			return err
		}
		delay := pollInterval
		if result.Events == batchSize {
			delay = 0
		}
		timer.Reset(delay)
	}
}
