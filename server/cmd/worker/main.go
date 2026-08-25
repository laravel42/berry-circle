// Command berry-worker runs Berry's durable orchestration workers (ADR-0005).
//
// It is a separate binary from the API on purpose. Workers hold long-lived
// agent streams and, once the human review gate lands, day-long waits for a
// person to decide something. Coupling that to the API process would mean
// every API deploy killed live agent work.
//
// The worker is a client of the same durable seams as the API — the run
// ledger, the OpenFang adapter, the realtime broadcaster — and introduces no
// new authority. PostgreSQL remains the system of record.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"

	"github.com/laravel42/berry-circle/server/internal/artifacts"
	"github.com/laravel42/berry-circle/server/internal/cache"
	"github.com/laravel42/berry-circle/server/internal/config"
	"github.com/laravel42/berry-circle/server/internal/database"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	collaborationrepo "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	intakerepo "github.com/laravel42/berry-circle/server/internal/repository/intake"
	runsrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
	"github.com/laravel42/berry-circle/server/internal/service/runadmission"
	"github.com/laravel42/berry-circle/server/internal/storage"
)

func main() {
	os.Exit(run())
}

func run() int {
	cfg, err := config.FromEnv()
	if err != nil {
		slog.Error("configuration failed", "error", err)
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: cfg.LogLevel,
	})).With("service", cfg.ServiceName+"-worker")

	if !cfg.TemporalEnabled {
		logger.Error("worker requires TEMPORAL_ENABLED=true")
		return 1
	}
	if cfg.DatabaseURL == "" {
		logger.Error("worker requires DATABASE_URL")
		return 1
	}

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.ServiceName)
	if err != nil {
		logger.Error("database setup failed", "error", err)
		return 1
	}
	defer pool.Close()

	// The worker publishes the same run events the API streams to browsers, so
	// it needs the relay. Without Valkey it can still run: events reach only
	// subscribers attached to this process, which is correct for a single-node
	// deployment and degraded but safe otherwise.
	var valkeyClient *cache.Client
	if cfg.ValkeyEnabled {
		valkeyClient, err = cache.Open(ctx, cfg.ValkeyURL)
		if err != nil {
			if cfg.ValkeyRequired {
				logger.Error("required Valkey setup failed", "error", err)
				return 1
			}
			logger.Warn("optional Valkey unavailable", "error", err)
		}
	}
	defer closeValkey(valkeyClient)

	hub, err := realtime.NewHub(cfg.RealtimeBuffer)
	if err != nil {
		logger.Error("realtime setup failed", "error", err)
		return 1
	}
	defer func() { _ = hub.Close() }()

	var relay realtime.Relay
	if valkeyClient != nil {
		relay, err = realtime.NewValkeyRelay(
			valkeyClient.Raw(),
			realtime.ValkeyRelayConfig{
				NodeID:       cfg.RealtimeNodeID,
				StreamMaxLen: cfg.RealtimeStreamMaxLen,
				StreamTTL:    cfg.RealtimeStreamTTL,
				ReadBlock:    cfg.RealtimeReadBlock,
			},
		)
		if err != nil {
			logger.Error("realtime relay setup failed", "error", err)
			return 1
		}
		defer func() { _ = relay.Close() }()
	}

	broadcaster, err := realtime.NewDistributed(hub, relay, realtime.DistributedConfig{
		Required:  cfg.RealtimeRelayRequired,
		DedupeTTL: cfg.RealtimeStreamTTL,
		Logger:    logger,
	})
	if err != nil {
		logger.Error("realtime manager setup failed", "error", err)
		return 1
	}
	defer func() { _ = broadcaster.Close() }()

	upstream, err := openfang.New(
		cfg.OpenFangBaseURL,
		cfg.OpenFangAPIKey,
		&http.Client{Timeout: 0, Transport: &http.Transport{
			MaxIdleConns:          64,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
		}},
		logger,
	)
	if err != nil {
		logger.Error("runtime transport setup failed", "error", err)
		return 1
	}

	runStore, err := runsrepo.New(pool)
	if err != nil {
		logger.Error("run repository setup failed", "error", err)
		return 1
	}
	intakeStore, err := intakerepo.New(pool)
	if err != nil {
		logger.Error("intake repository setup failed", "error", err)
		return 1
	}

	// Worker count is 0 here on purpose: Temporal owns scheduling, so the
	// in-process job channel must not also be draining runs. Sharing the
	// service gives both dispatchers one projection implementation without
	// giving this process a second scheduler.
	dispatcher, err := runadmission.New(runadmission.Options{
		Store:         runStore,
		OpenFang:      upstream,
		Broadcaster:   broadcaster,
		Clock:         time.Now,
		NewID:         uuid.New,
		WorkerContext: ctx,
		Workers:       1,
		QueueSize:     1,
	})
	if err != nil {
		logger.Error("run dispatcher setup failed", "error", err)
		return 1
	}
	defer func() {
		closeCtx, cancel := context.WithTimeout(
			context.Background(),
			cfg.ShutdownTimeout,
		)
		defer cancel()
		_ = dispatcher.Close(closeCtx)
	}()

	// Parsed, not asserted: MustParse turns a bad config value into a panic and
	// a crash loop, which is the least useful way to report a typo.
	actorID, err := uuid.Parse(cfg.IntakeActorID)
	if err != nil {
		logger.Error(
			"INTAKE_ACTOR_ID is not a valid UUID",
			"value", cfg.IntakeActorID,
			"error", err,
		)
		return 1
	}
	// Artifact promotion (ADR-0006). Both dependencies are optional: without a
	// mounted runtime volume the promoter reports itself disabled and the
	// activity is a no-op, which is what a deployment did before this existed.
	var (
		promoter     *artifacts.Promoter
		artifactRuns orchestration.RunArtifactSource
	)
	if cfg.RuntimeWorkspaceRoot != "" {
		artifactStore, err := collaborationrepo.New(pool)
		if err != nil {
			logger.Error("collaboration repository setup failed", "error", err)
			return 1
		}
		artifactStorage, err := storage.NewWithContext(ctx, storage.Config{
			Backend:           cfg.StorageBackend,
			LocalRoot:         cfg.StorageLocalRoot,
			MaxBytes:          cfg.StorageMaxBytes,
			S3Bucket:          cfg.S3Bucket,
			S3Region:          cfg.S3Region,
			S3Endpoint:        cfg.S3Endpoint,
			S3UsePathStyle:    cfg.S3UsePathStyle,
			S3UsePathStyleSet: cfg.S3UsePathStyleSet,
			S3AccessKeyID:     cfg.S3AccessKeyID,
			S3SecretAccessKey: cfg.S3SecretAccessKey,
			S3SessionToken:    cfg.S3SessionToken,
		})
		if err != nil {
			logger.Error("artifact storage setup failed", "error", err)
			return 1
		}
		promoter = &artifacts.Promoter{
			Root:     cfg.RuntimeWorkspaceRoot,
			Store:    artifactStore,
			Storage:  artifactStorage,
			MaxBytes: cfg.StorageMaxBytes,
			Clock:    time.Now,
			NewID:    uuid.New,
			Logger:   logger,
		}
		artifactRuns = promotableRuns{store: runStore}
		logger.Info("artifact promotion enabled", "root", cfg.RuntimeWorkspaceRoot)
	}

	activities, err := orchestration.NewActivities(orchestration.Activities{
		Intake:       intakeStore,
		Runs:         dispatcher,
		ActorID:      actorID,
		Clock:        time.Now,
		NewID:        uuid.New,
		Artifacts:    promoter,
		ArtifactRuns: artifactRuns,
	})
	if err != nil {
		logger.Error("orchestration activities setup failed", "error", err)
		return 1
	}

	temporalClient, err := client.Dial(client.Options{
		HostPort:  cfg.TemporalHostPort,
		Namespace: cfg.TemporalNamespace,
		Logger:    newTemporalLogger(logger),
	})
	if err != nil {
		logger.Error("temporal connection failed", "error", err)
		return 1
	}
	defer temporalClient.Close()

	w := worker.New(temporalClient, cfg.TemporalTaskQueue, worker.Options{
		// Activity slots bound how many agent streams this worker holds open,
		// which is a provider-spend ceiling as much as a memory one.
		MaxConcurrentActivityExecutionSize: cfg.IntakeMaxConcurrent,
	})
	if err := orchestration.Register(w, activities); err != nil {
		logger.Error("orchestration registration failed", "error", err)
		return 1
	}

	if err := w.Start(); err != nil {
		logger.Error("temporal worker failed to start", "error", err)
		return 1
	}
	defer w.Stop()

	logger.Info(
		"worker started",
		"taskQueue", cfg.TemporalTaskQueue,
		"namespace", cfg.TemporalNamespace,
		"intakeEnabled", cfg.IntakeEnabled,
	)

	if cfg.IntakeEnabled {
		if err := startIntake(ctx, temporalClient, cfg); err != nil {
			logger.Error("intake loop failed to start", "error", err)
			return 1
		}
		logger.Info(
			"continuous intake running",
			"interval", cfg.IntakeInterval.String(),
			"batchSize", cfg.IntakeBatchSize,
			"maxConcurrent", cfg.IntakeMaxConcurrent,
		)
	}

	<-ctx.Done()
	logger.Info("worker shutting down")
	return 0
}

// startIntake ensures exactly one intake loop exists.
//
// The fixed workflow ID plus a reject-duplicate reuse policy means every
// worker replica can call this at startup and only the first creates the loop.
// An AlreadyStarted error is the expected outcome on replicas two and up, not
// a failure.
func startIntake(
	ctx context.Context,
	temporalClient client.Client,
	cfg config.Config,
) error {
	_, err := temporalClient.ExecuteWorkflow(
		ctx,
		client.StartWorkflowOptions{
			ID:        "berry-intake",
			TaskQueue: cfg.TemporalTaskQueue,
		},
		orchestration.IntakeOrchestrationName,
		orchestration.IntakeParams{
			BatchSize:     cfg.IntakeBatchSize,
			MaxConcurrent: cfg.IntakeMaxConcurrent,
			Interval:      cfg.IntakeInterval,
		},
	)
	if err != nil && isAlreadyStarted(err) {
		return nil
	}
	return err
}

func closeValkey(client *cache.Client) {
	if client != nil {
		_ = client.Close()
	}
}

// promotableRuns adapts the run repository to the orchestration interface.
//
// The two describe the same row and differ only in which package owns the type,
// which is what keeps orchestration free of a repository import.
type promotableRuns struct {
	store *runsrepo.Repository
}

func (adapter promotableRuns) PromotableRun(
	ctx context.Context,
	runID uuid.UUID,
) (orchestration.PromotableRun, error) {
	row, err := adapter.store.PromotableRun(ctx, runID)
	if err != nil {
		return orchestration.PromotableRun{}, err
	}
	return orchestration.PromotableRun{
		AgentSlug:   row.AgentSlug,
		StartedAt:   row.StartedAt,
		CompletedAt: row.CompletedAt,
		Succeeded:   row.Succeeded,
	}, nil
}
