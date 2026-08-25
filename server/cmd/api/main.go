package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"

	coreauth "github.com/laravel42/berry-circle/server/internal/auth"
	"github.com/laravel42/berry-circle/server/internal/cache"
	"github.com/laravel42/berry-circle/server/internal/config"
	"github.com/laravel42/berry-circle/server/internal/database"
	agenthandlers "github.com/laravel42/berry-circle/server/internal/handlers/agents"
	"github.com/laravel42/berry-circle/server/internal/handlers/attachments"
	authhandlers "github.com/laravel42/berry-circle/server/internal/handlers/auth"
	"github.com/laravel42/berry-circle/server/internal/handlers/boards"
	cataloghandlers "github.com/laravel42/berry-circle/server/internal/handlers/catalog"
	channelhandlers "github.com/laravel42/berry-circle/server/internal/handlers/channels"
	"github.com/laravel42/berry-circle/server/internal/handlers/comments"
	conversationhandlers "github.com/laravel42/berry-circle/server/internal/handlers/conversations"
	eventhandlers "github.com/laravel42/berry-circle/server/internal/handlers/events"
	identityhandlers "github.com/laravel42/berry-circle/server/internal/handlers/identity"
	integrationhandlers "github.com/laravel42/berry-circle/server/internal/handlers/integrations"
	"github.com/laravel42/berry-circle/server/internal/handlers/issues"
	p2handlers "github.com/laravel42/berry-circle/server/internal/handlers/p2"
	platformhandlers "github.com/laravel42/berry-circle/server/internal/handlers/platform"
	"github.com/laravel42/berry-circle/server/internal/handlers/projects"
	"github.com/laravel42/berry-circle/server/internal/handlers/reactions"
	"github.com/laravel42/berry-circle/server/internal/handlers/resolutions"
	runhandlers "github.com/laravel42/berry-circle/server/internal/handlers/runs"
	runtimehandlers "github.com/laravel42/berry-circle/server/internal/handlers/runtime"
	"github.com/laravel42/berry-circle/server/internal/handlers/subscribers"
	"github.com/laravel42/berry-circle/server/internal/httpapi"
	"github.com/laravel42/berry-circle/server/internal/identity"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	"github.com/laravel42/berry-circle/server/internal/integrations/oauth"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/modelcatalog"
	"github.com/laravel42/berry-circle/server/internal/observability"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/openrouter"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/platform"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	collabrepo "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	conversationrepo "github.com/laravel42/berry-circle/server/internal/repository/conversations"
	integrationrepo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
	p2repo "github.com/laravel42/berry-circle/server/internal/repository/p2"
	projectrepo "github.com/laravel42/berry-circle/server/internal/repository/projects"
	"github.com/laravel42/berry-circle/server/internal/secrets"
	p2service "github.com/laravel42/berry-circle/server/internal/service/p2"
	"github.com/laravel42/berry-circle/server/internal/service/runadmission"
	"github.com/laravel42/berry-circle/server/internal/storage"
	temporalclient "go.temporal.io/sdk/client"
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
	logger := observability.NewLogger(os.Stderr, cfg.LogLevel, cfg.ServiceName, cfg.Environment)
	tracerProvider, err := observability.SetupTracing(cfg.ServiceName)
	if err != nil {
		logger.Error("tracing setup failed", "error", err)
		return 1
	}
	tracingClosed := false
	defer func() {
		if tracingClosed {
			return
		}
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if shutdownErr := tracerProvider.Shutdown(closeCtx); shutdownErr != nil {
			logger.Error("tracing shutdown failed", "error", shutdownErr)
		}
	}()

	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	registry := prometheus.NewRegistry()
	if err := registry.Register(prometheus.NewGoCollector()); err != nil {
		logger.Error("metrics setup failed", "error", err)
		return 1
	}
	if err := registry.Register(prometheus.NewProcessCollector(
		prometheus.ProcessCollectorOpts{},
	)); err != nil {
		logger.Error("metrics setup failed", "error", err)
		return 1
	}
	metrics, err := observability.NewHTTPMetrics(registry)
	if err != nil {
		logger.Error("metrics setup failed", "error", err)
		return 1
	}

	var (
		dbPool  *pgxpool.Pool
		dbReady platformhandlers.Checker
	)
	if cfg.DatabaseURL != "" {
		pool, err := database.Open(ctx, cfg.DatabaseURL, cfg.ServiceName)
		if err != nil {
			logger.Error("database setup failed", "error", err)
			return 1
		}
		dbPool = pool
		readiness, err := database.NewReadiness(pool)
		if err != nil {
			pool.Close()
			logger.Error("database readiness setup failed", "error", err)
			return 1
		}
		dbReady = readiness
	}

	var valkeyClient *cache.Client
	if cfg.ValkeyEnabled {
		valkeyClient, err = cache.Open(ctx, cfg.ValkeyURL)
		if err != nil {
			if cfg.ValkeyRequired {
				closeDatabase(dbPool)
				logger.Error("required Valkey setup failed", "error", err)
				return 1
			}
			logger.Warn("optional Valkey unavailable; continuing without cache", "error", err)
			valkeyClient = nil
		}
	}
	valkeyReady := cache.Readiness{Client: valkeyClient, Required: cfg.ValkeyRequired}

	storageBackend, err := storage.NewWithContext(ctx, storage.Config{
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
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("storage setup failed", "error", err)
		return 1
	}
	hub, err := realtime.NewHub(cfg.RealtimeBuffer)
	if err != nil {
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("realtime setup failed", "error", err)
		return 1
	}
	realtimeObserver := &realtime.AtomicMetrics{}
	var relay realtime.Relay
	if valkeyClient != nil {
		relay, err = realtime.NewValkeyRelay(
			valkeyClient.Raw(),
			realtime.ValkeyRelayConfig{
				NodeID:       cfg.RealtimeNodeID,
				StreamMaxLen: cfg.RealtimeStreamMaxLen,
				StreamTTL:    cfg.RealtimeStreamTTL,
				ReadBlock:    cfg.RealtimeReadBlock,
				Observer:     realtimeObserver,
			},
		)
		if err != nil {
			_ = hub.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("realtime relay setup failed", "error", err)
			return 1
		}
	}
	realtimeManager, err := realtime.NewDistributed(
		hub,
		relay,
		realtime.DistributedConfig{
			Required:  cfg.RealtimeRelayRequired,
			DedupeTTL: cfg.RealtimeStreamTTL,
			Logger:    logger,
			Observer:  realtimeObserver,
		},
	)
	if err != nil {
		if relay != nil {
			_ = relay.Close()
		}
		_ = hub.Close()
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("distributed realtime setup failed", "error", err)
		return 1
	}
	if err := realtimeManager.Start(ctx); err != nil {
		_ = realtimeManager.Close()
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("distributed realtime startup failed", "error", err)
		return 1
	}

	upstreamHTTP := &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
		},
	}
	upstream, err := openfang.New(
		cfg.OpenFangBaseURL,
		cfg.OpenFangAPIKey,
		upstreamHTTP,
		logger,
	)
	if err != nil {
		_ = realtimeManager.Close()
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("runtime transport setup failed", "error", err)
		return 1
	}

	// Make every workspace's built-in orchestrator executable. This runs in the
	// API rather than the worker because the API always runs, while the worker
	// is optional and Temporal-gated — an orchestrator that only provisions
	// when Temporal is enabled is unreachable for most deployments. It also
	// keeps provisioning single-writer: two processes doing this concurrently
	// would both probe, both see 404, and both spawn, orphaning an agent.
	//
	// Ordered before the agent seed so the orchestrator already exists upstream
	// when reconciliation runs, rather than being marked offline and corrected.
	if dbPool != nil {
		if err := orchestration.EnsureOrchestrators(
			ctx,
			dbPool,
			upstream,
			orchestration.OrchestratorSpec{
				Provider: cfg.OrchestratorProvider,
				Model:    cfg.OrchestratorModel,
			},
			logger,
		); err != nil {
			logger.Warn("orchestrator bootstrap incomplete", "error", err)
		}
	}

	// Seed each workspace's agents from the runtime at boot. Without this the
	// list is empty until somebody opens the agents page, which leaves intake
	// with nothing to route to and the built-in orchestrator taking every task
	// by fallback. Best effort: an unreachable runtime is a normal boot
	// condition and the next agents request reconciles anyway.
	if dbPool != nil {
		agenthandlers.SyncAllWorkspaces(ctx, dbPool, upstream, time.Now, uuid.New, logger)
	}

	optionalCache := cache.FailOpen{
		Backend: valkeyClient,
		Enabled: cfg.CacheFailOpen,
		Logger:  logger,
	}
	dependencies := platform.Dependencies{
		DB:               dbPool,
		Valkey:           valkeyClient,
		Cache:            optionalCache,
		Logger:           logger,
		Metrics:          metrics,
		MetricsRegistry:  registry,
		Clock:            platform.RealClock{},
		IDs:              platform.UUIDGenerator{},
		OpenFang:         upstream,
		Storage:          storageBackend,
		Realtime:         realtimeManager,
		RealtimeManager:  realtimeManager,
		RealtimeObserver: realtimeObserver,
	}
	dependencies.StorageMetadata, _ = storageBackend.(storage.MetadataBackend)
	dependencies.StoragePresigner, _ = storageBackend.(storage.PresigningBackend)
	if err := dependencies.ValidateCore(); err != nil {
		_ = realtimeManager.Close()
		closeValkey(valkeyClient)
		closeDatabase(dbPool)
		logger.Error("platform dependency setup failed", "error", err)
		return 1
	}

	var routes httpapi.Registry
	for _, mount := range platformhandlers.Mounts(platformhandlers.Options{
		Database:       dbReady,
		Valkey:         valkeyReady,
		Realtime:       realtimeManager,
		MetricsEnabled: cfg.MetricsEnabled,
		Gatherer:       registry,
		Capabilities: platformhandlers.Capabilities{
			AgentExecution: true,
			Metrics:        cfg.MetricsEnabled,
			Realtime:       true,
			Storage:        true,
			Valkey:         valkeyClient != nil,
		},
	}) {
		if err := routes.Register(mount); err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("route registration failed", "error", err)
			return 1
		}
	}
	var runRoutes *runhandlers.Handlers
	if dbPool != nil {
		sessions, err := coreauth.NewService(coreauth.ServiceOptions{
			Pool:       dbPool,
			Now:        time.Now,
			NewID:      uuid.New,
			Random:     rand.Reader,
			SessionTTL: cfg.SessionTTL,
		})
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("session service setup failed", "error", err)
			return 1
		}
		idempotencyStore := httpapi.PostgresIdempotencyStore{Pool: dbPool}
		identityService, err := identity.NewService(identity.ServiceOptions{
			Pool:   dbPool,
			Now:    time.Now,
			NewID:  uuid.New,
			Random: rand.Reader,
		})
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("identity service setup failed", "error", err)
			return 1
		}
		authenticator, err := identityService.Authenticator(sessions)
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("identity authenticator setup failed", "error", err)
			return 1
		}
		identityMounts, err := identityhandlers.NewMounts(identityhandlers.Options{
			Authenticator: authenticator,
			Service:       identityService,
			Clock:         time.Now,
		})
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("identity route setup failed", "error", err)
			return 1
		}

		// Route admitted runs through Temporal when it is configured, so a run
		// survives the process that accepted it. Nil keeps the in-process pool,
		// which remains a supported configuration.
		var runDispatcher runadmission.Dispatcher
		if cfg.TemporalEnabled {
			temporalClient, dialErr := temporalclient.Dial(temporalclient.Options{
				HostPort:  cfg.TemporalHostPort,
				Namespace: cfg.TemporalNamespace,
			})
			if dialErr != nil {
				if cfg.TemporalRequired {
					closeRunRoutes(runRoutes, logger)
					_ = realtimeManager.Close()
					closeValkey(valkeyClient)
					closeDatabase(dbPool)
					logger.Error("required Temporal connection failed", "error", dialErr)
					return 1
				}
				logger.Warn("optional Temporal unavailable; using in-process dispatch", "error", dialErr)
			} else {
				defer temporalClient.Close()
				dispatcher, dispatchErr := orchestration.NewTemporalDispatcher(
					temporalClient, cfg.TemporalTaskQueue,
				)
				if dispatchErr != nil {
					logger.Error("temporal dispatcher setup failed", "error", dispatchErr)
					return 1
				}
				runDispatcher = dispatcher
				logger.Info(
					"run dispatch routed through Temporal",
					"namespace", cfg.TemporalNamespace,
					"taskQueue", cfg.TemporalTaskQueue,
				)
			}
		}

		// The attachments ledger, which also indexes what a run produced.
		runArtifactStore, err := collabrepo.New(dbPool)
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("run artifact store setup failed", "error", err)
			return 1
		}

		runRoutes, err = runhandlers.New(runhandlers.Options{
			// Lists a run's promoted outputs (ADR-0006).
			Artifacts:        runArtifactStore,
			Dispatcher:       runDispatcher,
			Pool:             dbPool,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			OpenFang:         upstream,
			Broadcaster:      realtimeManager,
			WorkerContext:    ctx,
			Authorization:    identityService,
		})
		if err != nil {
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("run route setup failed", "error", err)
			return 1
		}

		authMount, err := authhandlers.NewMount(authhandlers.Options{
			Pool:          dbPool,
			Sessions:      sessions,
			Authenticator: authenticator,
			Clock:         time.Now,
			NewID:         uuid.New,
			Login: authhandlers.LoginConfig{
				AllowKnownEmail: cfg.AllowPasswordlessAuth,
				Environment:     cfg.Environment,
			},
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("auth route setup failed", "error", err)
			return 1
		}
		boardMount, err := boards.NewMount(boards.Options{
			Pool:             dbPool,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			Authorization:    identityService,
			RunHandler:       runRoutes.BoardHandler(),
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("board route setup failed", "error", err)
			return 1
		}
		agentMount, err := agenthandlers.NewMount(agenthandlers.Options{
			Pool:       dbPool,
			Sessions:   authenticator,
			Clock:      time.Now,
			NewID:      uuid.New,
			OpenFang:   upstream,
			Configurer: upstream,
			// The runtime's OpenRouter entries are compiled into its binary and
			// go stale, so a model published since that build reads as
			// unavailable and cannot be selected. Serve OpenRouter's live
			// catalog for its own models and keep the runtime's for every other
			// provider. Listing needs no credential.
			Catalog: &modelcatalog.Merged{
				Runtime:    upstream,
				OpenRouter: openrouter.New("", nil),
			},
			Authorization: identityService,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("agent route setup failed", "error", err)
			return 1
		}
		runtimeMount, err := runtimehandlers.NewMount(runtimehandlers.Options{
			Sessions:      authenticator,
			Authorization: identityService,
			OpenFang:      upstream,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("runtime route setup failed", "error", err)
			return 1
		}
		eventMount, err := eventhandlers.NewMount(eventhandlers.Options{
			Pool:          dbPool,
			Sessions:      authenticator,
			Clock:         time.Now,
			Broadcaster:   realtimeManager,
			Authorization: identityService,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("event route setup failed", "error", err)
			return 1
		}

		collaborationStore, err := collabrepo.New(dbPool)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("collaboration store setup failed", "error", err)
			return 1
		}
		attachmentOptions := attachments.Options{
			Store:            collaborationStore,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			Storage:          storageBackend,
			Broadcaster:      realtimeManager,
			MaxBytes:         cfg.StorageMaxBytes,
		}
		if presigner, ok := storageBackend.(storage.PresigningBackend); ok {
			attachmentOptions.Presigner = presigner
		}
		attachmentMount, err := attachments.NewMount(attachmentOptions)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("attachment route setup failed", "error", err)
			return 1
		}
		issueAttachments, err := attachments.NewIssueHandler(attachmentOptions)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("issue attachment route setup failed", "error", err)
			return 1
		}
		commentAttachments, err := attachments.NewCommentHandler(attachmentOptions)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("comment attachment route setup failed", "error", err)
			return 1
		}
		reactionOptions := reactions.Options{
			Store:            collaborationStore,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			Broadcaster:      realtimeManager,
		}
		issueReactions, err := reactions.NewIssueHandler(reactionOptions)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("issue reaction route setup failed", "error", err)
			return 1
		}
		commentReactions, err := reactions.NewCommentHandler(reactionOptions)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("comment reaction route setup failed", "error", err)
			return 1
		}
		issueSubscribers, err := subscribers.NewIssueHandler(subscribers.Options{
			Store:            collaborationStore,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			Broadcaster:      realtimeManager,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("subscriber route setup failed", "error", err)
			return 1
		}
		commentResolutions, err := resolutions.NewCommentHandler(resolutions.Options{
			Store:            collaborationStore,
			Sessions:         authenticator,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
			Broadcaster:      realtimeManager,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("resolution route setup failed", "error", err)
			return 1
		}
		catalogMount, err := cataloghandlers.NewMount(cataloghandlers.Options{
			Pool:             dbPool,
			Sessions:         authenticator,
			Authorization:    identityService,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("catalog route setup failed", "error", err)
			return 1
		}
		projectMount, err := projects.NewMount(projects.Options{
			Pool:             dbPool,
			Sessions:         authenticator,
			Authorization:    identityService,
			Clock:            time.Now,
			NewID:            uuid.New,
			IdempotencyStore: idempotencyStore,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("project route setup failed", "error", err)
			return 1
		}
		p2Store, err := p2repo.New(dbPool)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("p2 store setup failed", "error", err)
			return 1
		}
		projectStore, err := projectrepo.New(dbPool)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("project store setup failed", "error", err)
			return 1
		}
		p2API, err := p2service.New(p2service.Options{
			Store:         p2Store,
			Authorization: identityService,
			Projects:      projectPinValidator{store: projectStore},
			Clock:         time.Now,
			NewID:         uuid.New,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("p2 service setup failed", "error", err)
			return 1
		}
		p2Mounts, err := p2handlers.NewMounts(p2handlers.Options{
			Sessions:         authenticator,
			Service:          p2API,
			IdempotencyStore: idempotencyStore,
			Clock:            time.Now,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("p2 route setup failed", "error", err)
			return 1
		}
		inboxProjector, err := p2service.NewProjector(p2service.ProjectorOptions{
			Store: p2Store,
			Clock: time.Now,
			NewID: uuid.New,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("inbox projector setup failed", "error", err)
			return 1
		}
		go func() {
			if runErr := inboxProjector.Run(ctx, 2*time.Second, 100); runErr != nil &&
				!errors.Is(runErr, context.Canceled) {
				logger.Error("inbox projector stopped", "error", runErr)
			}
		}()

		issueMount, err := issues.NewMount(issues.Options{
			Pool:              dbPool,
			Sessions:          authenticator,
			Clock:             time.Now,
			NewID:             uuid.New,
			IdempotencyStore:  idempotencyStore,
			RunHandler:        runRoutes.IssueHandler(),
			Authorization:     identityService,
			Broadcaster:       realtimeManager,
			AttachmentHandler: issueAttachments,
			ReactionHandler:   issueReactions,
			SubscriberHandler: issueSubscribers,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("issue route setup failed", "error", err)
			return 1
		}
		commentMount, err := comments.NewMount(comments.Options{
			Pool:              dbPool,
			Sessions:          authenticator,
			Clock:             time.Now,
			NewID:             uuid.New,
			IdempotencyStore:  idempotencyStore,
			Authorization:     identityService,
			Broadcaster:       realtimeManager,
			AttachmentHandler: commentAttachments,
			ReactionHandler:   commentReactions,
			ResolutionHandler: commentResolutions,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("comment route setup failed", "error", err)
			return 1
		}
		// Integrations are mounted only when a sealing key is configured. The
		// same reasoning as the channel webhook below: a deployment that cannot
		// encrypt provider credentials must not expose the routes that collect
		// them.
		var integrationMounts []httpapi.Mount
		if cfg.IntegrationsEnabled {
			sealer, err := secrets.NewFromBase64Key(cfg.IntegrationEncryptionKey)
			if err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("integration sealer setup failed", "error", err)
				return 1
			}
			integrationStore, err := integrationrepo.New(dbPool, sealer)
			if err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("integration repository setup failed", "error", err)
				return 1
			}
			providerRegistry := integrationcore.NewRegistry()
			for _, provider := range providers.All() {
				if err := providerRegistry.Register(provider); err != nil {
					closeRunRoutes(runRoutes, logger)
					_ = realtimeManager.Close()
					closeValkey(valkeyClient)
					closeDatabase(dbPool)
					logger.Error("integration provider registration failed", "error", err)
					return 1
				}
			}
			integrationMount, err := integrationhandlers.NewMount(integrationhandlers.Options{
				Store:           integrationStore,
				Sessions:        authenticator,
				Authorization:   identityService,
				Clock:           time.Now,
				Registry:        providerRegistry,
				Configs:         oauth.LoadConfigs(providerScopes(providerRegistry)),
				CallbackBaseURL: cfg.IntegrationCallbackBaseURL,
				ReturnAllowlist: cfg.IntegrationRedirectAllowlist,
				Logger:          logger,
			})
			if err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("integration route setup failed", "error", err)
				return 1
			}
			integrationMounts = append(integrationMounts, integrationMount)
		}
		productMounts := []httpapi.Mount{
			authMount,
			boardMount,
			agentMount,
			runtimeMount,
			runRoutes.Mount(),
			eventMount,
			issueMount,
			commentMount,
			attachmentMount,
			catalogMount,
			projectMount,
		}
		productMounts = append(productMounts, integrationMounts...)
		// The inbound channel webhook is mounted only when Infobip is
		// configured. An unconfigured deployment must not expose a public
		// endpoint that creates messages attributed to users.
		if cfg.InfobipEnabled {
			conversationStore, err := conversationrepo.New(dbPool)
			if err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("conversation repository setup failed", "error", err)
				return 1
			}
			channelMount, err := channelhandlers.NewMount(channelhandlers.Options{
				Store:  conversationStore,
				Secret: cfg.InfobipWebhookSecret,
				Clock:  time.Now,
				Logger: logger,
			})
			if err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("channel webhook setup failed", "error", err)
				return 1
			}
			productMounts = append(productMounts, channelMount)
		}
		conversationStore, err := conversationrepo.New(dbPool)
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("conversation repository setup failed", "error", err)
			return 1
		}
		chatMount, err := conversationhandlers.NewMount(conversationhandlers.Options{
			Store:     conversationStore,
			Responder: upstream,
			Sessions:  authenticator,
			Clock:     time.Now,
			Logger:    logger,
		})
		if err != nil {
			closeRunRoutes(runRoutes, logger)
			_ = realtimeManager.Close()
			closeValkey(valkeyClient)
			closeDatabase(dbPool)
			logger.Error("conversation route setup failed", "error", err)
			return 1
		}
		productMounts = append(productMounts, chatMount)
		productMounts = append(productMounts, identityMounts...)
		productMounts = append(productMounts, p2Mounts...)
		for _, mount := range productMounts {
			if err := routes.Register(mount); err != nil {
				closeRunRoutes(runRoutes, logger)
				_ = realtimeManager.Close()
				closeValkey(valkeyClient)
				closeDatabase(dbPool)
				logger.Error("product route registration failed", "error", err)
				return 1
			}
		}
	}

	server := &http.Server{
		Addr: cfg.APIAddr,
		Handler: routes.Handler(httpapi.Options{
			Logger:         logger,
			Metrics:        metrics,
			TrustedOrigins: cfg.TrustedOrigins,
			AllowPrivateBrowserOrigins: cfg.Environment == "development" ||
				cfg.Environment == "test",
		}),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()
	logger.Info("Berry API listening", "apiAddr", cfg.APIAddr, "config", cfg.SafeSummary())

	exitCode := 0
	select {
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server stopped", "error", err)
			exitCode = 1
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful HTTP shutdown failed", "error", err)
		_ = server.Close()
		exitCode = 1
	}
	if runRoutes != nil {
		if err := runRoutes.Close(shutdownCtx); err != nil {
			logger.Error("run worker shutdown failed", "error", err)
			exitCode = 1
		}
	}
	if err := realtimeManager.Close(); err != nil {
		logger.Error("realtime shutdown failed", "error", err)
		exitCode = 1
	}
	closeValkey(valkeyClient)
	closeDatabase(dbPool)
	if err := tracerProvider.Shutdown(shutdownCtx); err != nil {
		logger.Error("tracing shutdown failed", "error", err)
		exitCode = 1
	}
	tracingClosed = true
	upstreamHTTP.CloseIdleConnections()
	logger.Info("Berry API stopped")
	return exitCode
}

func closeDatabase(pool *pgxpool.Pool) {
	if pool != nil {
		pool.Close()
	}
}

func closeValkey(client *cache.Client) {
	if client != nil {
		_ = client.Close()
	}
}

func closeRunRoutes(routes *runhandlers.Handlers, logger *slog.Logger) {
	if routes == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := routes.Close(ctx); err != nil {
		logger.Error("run worker shutdown failed", "error", err)
	}
}

type projectPinValidator struct {
	store *projectrepo.Repository
}

func (validator projectPinValidator) ProjectExists(
	ctx context.Context,
	workspaceID, projectID uuid.UUID,
) (bool, error) {
	if validator.store == nil {
		return false, errors.New("project pin validator store is nil")
	}
	_, err := validator.store.Get(ctx, workspaceID, projectID)
	if errors.Is(err, projectrepo.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// providerScopes lets the OAuth loader ask the registry what to request,
// so the scopes a provider declares and the scopes Berry asks for cannot drift.
func providerScopes(registry *integrationcore.Registry) func(string) []string {
	return func(id string) []string {
		provider, ok := registry.Get(id)
		if !ok {
			return nil
		}
		return provider.Scopes()
	}
}
