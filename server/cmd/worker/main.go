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
	"github.com/laravel42/berry-circle/server/internal/delivery"
	githubclient "github.com/laravel42/berry-circle/server/internal/integrations/github"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	collaborationrepo "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	corerepo "github.com/laravel42/berry-circle/server/internal/repository/core"
	intakerepo "github.com/laravel42/berry-circle/server/internal/repository/intake"
	integrationrepo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
	runsrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
	"github.com/laravel42/berry-circle/server/internal/secrets"
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
		// One bound for how long an agent may work. The dispatch activity
		// allows a few minutes beyond it, so this close is what ends an
		// overlong stream and the ledger records STREAM_TIMEOUT before
		// Temporal would give the activity up; a shorter client-side limit
		// would instead hang up on a run the activity was still prepared to
		// wait for.
		openfang.WithStreamTimeout(orchestration.DispatchStreamTimeout),
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
	// Where a run posts its result: the issue's comments, authored by the
	// agent, through the same store the comment routes write with.
	commentStore, err := corerepo.New(pool)
	if err != nil {
		logger.Error("comment repository setup failed", "error", err)
		return 1
	}

	// Worker count is 0 here on purpose: Temporal owns scheduling, so the
	// in-process job channel must not also be draining runs. Sharing the
	// service gives both dispatchers one projection implementation without
	// giving this process a second scheduler.
	// Repository context for runs. This is the process that actually dispatches
	// them — the API builds the same service for its own routes, but every run
	// admitted by intake comes through here, so wiring only the API left the
	// context unbuilt on the one path that matters.
	var runCode runadmission.CodeContext
	if cfg.IntegrationsEnabled {
		sealer, sealerErr := secrets.NewFromBase64Key(cfg.IntegrationEncryptionKey)
		if sealerErr != nil {
			logger.Error("integration sealer setup failed", "error", sealerErr)
			return 1
		}
		credentials, storeErr := integrationrepo.New(pool, sealer)
		if storeErr != nil {
			logger.Error("integration repository setup failed", "error", storeErr)
			return 1
		}
		runCode = githubclient.RunContext{Credentials: credentials, Logger: logger}
		logger.Info("repository context enabled for runs")
	}

	dispatcher, err := runadmission.New(runadmission.Options{
		Store:         runStore,
		OpenFang:      upstream,
		Broadcaster:   broadcaster,
		Clock:         time.Now,
		NewID:         uuid.New,
		WorkerContext: ctx,
		Workers:       1,
		QueueSize:     1,
		Code:          runCode,
		Comments:      commentStore,
		Logger:        logger,
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

		// Recover anything an earlier run left behind. In the background: a
		// worker must start serving whether or not a filesystem sweep succeeds.
		go func(promoter *artifacts.Promoter, source artifacts.PendingSource) {
			recovered, err := artifacts.Recover(ctx, promoter, source, time.Now(), logger)
			if err != nil {
				logger.Warn("artifact recovery pass failed", "error", err)
				return
			}
			if recovered > 0 {
				logger.Info("artifact recovery complete", "files", recovered)
			}
		}(promoter, artifactRuns.(promotableRuns))
	}

	// Delivery turns a finished run's output into a pull request. Needs the
	// same credential the context builder uses and the promoter's file
	// discovery, so it only exists when both do.
	var (
		runDeliveries   orchestration.RunDelivery
		deliverableRows orchestration.DeliverableRuns
	)
	if promoter != nil && runCode != nil {
		sealer, sealerErr := secrets.NewFromBase64Key(cfg.IntegrationEncryptionKey)
		if sealerErr == nil {
			credentials, storeErr := integrationrepo.New(pool, sealer)
			if storeErr == nil {
				runDeliveries = runDelivery{service: &delivery.Service{
					Output:    promoter,
					Publisher: githubclient.Publisher{Credentials: credentials},
				}}
				deliverableRows = deliverableRuns{store: runStore}
				logger.Info("pull request delivery enabled for runs")
			}
		}
	}

	activities, err := orchestration.NewActivities(orchestration.Activities{
		Intake:          intakeStore,
		Runs:            dispatcher,
		ActorID:         actorID,
		Clock:           time.Now,
		NewID:           uuid.New,
		Artifacts:       promoter,
		ArtifactRuns:    artifactRuns,
		Delivery:        runDeliveries,
		DeliverableRuns: deliverableRows,
		Logger:          logger,
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

func (adapter promotableRuns) RunsAwaitingPromotion(
	ctx context.Context,
	since time.Time,
	limit int,
) ([]uuid.UUID, error) {
	return adapter.store.RunsAwaitingPromotion(ctx, since, limit)
}

// PromotableRunContext reports whether a run is one whose output may be
// published, and the window its files must fall in. The boolean separates "not
// eligible" from "could not be read", so a failed run is skipped quietly while
// a broken lookup is logged.
func (adapter promotableRuns) PromotableRunContext(
	ctx context.Context,
	runID uuid.UUID,
) (artifacts.RunContext, bool, error) {
	row, err := adapter.store.PromotableRun(ctx, runID)
	if err != nil {
		return artifacts.RunContext{}, false, err
	}
	if !row.Succeeded {
		return artifacts.RunContext{}, false, nil
	}
	return artifacts.RunContext{
		RunID:       runID,
		AgentSlug:   row.AgentSlug,
		StartedAt:   row.StartedAt,
		CompletedAt: row.CompletedAt,
	}, true, nil
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

// deliverableRuns adapts the run repository to the orchestration interface.
type deliverableRuns struct {
	store *runsrepo.Repository
}

func (adapter deliverableRuns) DeliverableRun(
	ctx context.Context,
	runID uuid.UUID,
) (orchestration.DeliverableRun, error) {
	row, err := adapter.store.DeliverableRun(ctx, runID)
	if err != nil {
		return orchestration.DeliverableRun{}, err
	}
	return orchestration.DeliverableRun{
		WorkspaceID:     row.WorkspaceID,
		Repository:      row.Repository,
		AgentSlug:       row.AgentSlug,
		IssueIdentifier: row.IssueIdentifier,
		IssueTitle:      row.IssueTitle,
		StartedAt:       row.StartedAt,
		CompletedAt:     row.CompletedAt,
		Succeeded:       row.Succeeded,
	}, nil
}

// runDelivery adapts the delivery service, returning the pull request URL.
type runDelivery struct {
	service *delivery.Service
}

func (adapter runDelivery) Deliver(
	ctx context.Context,
	run delivery.Run,
	window artifacts.RunContext,
) (string, error) {
	pull, err := adapter.service.Deliver(ctx, run, window)
	if err != nil {
		return "", err
	}
	return pull.HTMLURL, nil
}
