// Package platform defines the shared dependencies consumed by domain modules.
package platform

import (
	"errors"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/laravel42/berry-circle/server/internal/cache"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

// Clock makes time-dependent domain behavior deterministic in tests.
type Clock interface {
	Now() time.Time
}

// RealClock is the process clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now().UTC() }

// IDGenerator mints Berry-owned UUIDs before durable writes or dispatch.
type IDGenerator interface {
	New() uuid.UUID
}

// UUIDGenerator uses cryptographically random RFC 4122 UUIDs.
type UUIDGenerator struct{}

func (UUIDGenerator) New() uuid.UUID { return uuid.New() }

// Dependencies contains process-owned services. PostgreSQL and Valkey may be
// nil in dependency-light development, but handlers must fail explicitly.
type Dependencies struct {
	DB               *pgxpool.Pool
	Valkey           *cache.Client
	Cache            cache.Store
	Logger           *slog.Logger
	Metrics          *observability.HTTPMetrics
	MetricsRegistry  *prometheus.Registry
	Clock            Clock
	IDs              IDGenerator
	OpenFang         openfang.Transport
	Storage          storage.Backend
	StorageMetadata  storage.MetadataBackend
	StoragePresigner storage.PresigningBackend
	Realtime         realtime.Broadcaster
	RealtimeManager  realtime.ManagedBroadcaster
	RealtimeObserver realtime.Observer
}

// ValidateCore checks services that every mounted domain package can rely on.
func (dependencies Dependencies) ValidateCore() error {
	switch {
	case dependencies.Logger == nil:
		return errors.New("platform logger is required")
	case dependencies.MetricsRegistry == nil:
		return errors.New("platform metrics registry is required")
	case dependencies.Clock == nil:
		return errors.New("platform clock is required")
	case dependencies.IDs == nil:
		return errors.New("platform ID generator is required")
	case dependencies.OpenFang == nil:
		return errors.New("platform runtime transport is required")
	case dependencies.Storage == nil:
		return errors.New("platform storage is required")
	case dependencies.Realtime == nil:
		return errors.New("platform realtime broadcaster is required")
	default:
		return nil
	}
}
