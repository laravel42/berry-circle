// Package approvals runs the housekeeping around approval requests. The
// expiry sweep closes requests nobody decided in time, and the
// approval.expired fact it emits is what fails the workflow step that
// waited on them (APPROVAL_EXPIRED) through the trigger dispatcher.
package approvals

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
)

// DefaultSweepLimit bounds one sweep.
const DefaultSweepLimit = 200

// ExpiryStore closes due approvals.
type ExpiryStore interface {
	ExpireDue(context.Context, time.Time, int, func() uuid.UUID) ([]approvalrepo.Approval, []approvalrepo.Event, error)
}

// SweeperOptions are explicit dependencies.
type SweeperOptions struct {
	Store       ExpiryStore
	Clock       func() time.Time
	NewID       func() uuid.UUID
	Broadcaster realtime.Broadcaster
	Logger      *slog.Logger
	Metrics     *observability.AutomationMetrics
	// Limit bounds one sweep; zero selects DefaultSweepLimit.
	Limit int
}

// Sweeper expires overdue approvals on an interval.
type Sweeper struct {
	options SweeperOptions
}

// NewSweeper validates the required dependencies.
func NewSweeper(options SweeperOptions) (*Sweeper, error) {
	switch {
	case options.Store == nil:
		return nil, errors.New("approval sweeper store is nil")
	case options.Clock == nil:
		return nil, errors.New("approval sweeper clock is nil")
	case options.NewID == nil:
		return nil, errors.New("approval sweeper ID generator is nil")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	if options.Limit == 0 {
		options.Limit = DefaultSweepLimit
	}
	if options.Limit < 1 || options.Limit > 1000 {
		return nil, errors.New("approval sweeper limit is invalid")
	}
	return &Sweeper{options: options}, nil
}

// RunOnce expires every approval due now, at most Limit, and publishes the
// facts. It returns how many it closed.
func (sweeper *Sweeper) RunOnce(ctx context.Context) (int, error) {
	now := sweeper.options.Clock().UTC()
	expired, events, err := sweeper.options.Store.ExpireDue(ctx, now, sweeper.options.Limit, sweeper.options.NewID)
	if err != nil {
		return 0, err
	}
	sweeper.publish(ctx, events)
	sweeper.options.Metrics.SetExpiryRun(now)
	if len(expired) > 0 {
		sweeper.options.Logger.Info("approvals expired", "count", len(expired))
	}
	return len(expired), nil
}

// Run sweeps on the interval until the context ends. A failed sweep is
// logged and retried on the next interval.
func (sweeper *Sweeper) Run(ctx context.Context, interval time.Duration) error {
	if interval <= 0 {
		return errors.New("approval sweeper interval is invalid")
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
		count, err := sweeper.RunOnce(ctx)
		delay := interval
		switch {
		case errors.Is(err, context.Canceled):
			return err
		case err != nil:
			sweeper.options.Logger.Error("approval expiry sweep failed", "error", err)
		case count == sweeper.options.Limit:
			delay = 0
		}
		timer.Reset(delay)
	}
}

func (sweeper *Sweeper) publish(ctx context.Context, events []approvalrepo.Event) {
	if sweeper.options.Broadcaster == nil {
		return
	}
	publishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	for _, event := range events {
		if event.ID == uuid.Nil {
			continue
		}
		boardID := ""
		if event.BoardID != uuid.Nil {
			boardID = event.BoardID.String()
		}
		_ = sweeper.options.Broadcaster.Publish(publishCtx, realtime.Event{
			ID: event.ID.String(), WorkspaceID: event.WorkspaceID.String(), BoardID: boardID,
			Type: event.Type, Payload: event.Payload, OccurredAt: event.OccurredAt,
		})
	}
}
