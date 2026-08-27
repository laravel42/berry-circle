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
	"github.com/laravel42/berry-circle/server/internal/autogate"
	"github.com/laravel42/berry-circle/server/internal/cache"
	"github.com/laravel42/berry-circle/server/internal/config"
	"github.com/laravel42/berry-circle/server/internal/database"
	"github.com/laravel42/berry-circle/server/internal/delivery"
	integrationcore "github.com/laravel42/berry-circle/server/internal/integrations/core"
	githubclient "github.com/laravel42/berry-circle/server/internal/integrations/github"
	"github.com/laravel42/berry-circle/server/internal/integrations/providers"
	"github.com/laravel42/berry-circle/server/internal/openfang"
	"github.com/laravel42/berry-circle/server/internal/openrouter"
	"github.com/laravel42/berry-circle/server/internal/orchestration"
	"github.com/laravel42/berry-circle/server/internal/priorwork"
	"github.com/laravel42/berry-circle/server/internal/realtime"
	approvalrepo "github.com/laravel42/berry-circle/server/internal/repository/approvals"
	automationrepo "github.com/laravel42/berry-circle/server/internal/repository/automation"
	collaborationrepo "github.com/laravel42/berry-circle/server/internal/repository/collaboration"
	corerepo "github.com/laravel42/berry-circle/server/internal/repository/core"
	goalrepo "github.com/laravel42/berry-circle/server/internal/repository/goals"
	intakerepo "github.com/laravel42/berry-circle/server/internal/repository/intake"
	integrationrepo "github.com/laravel42/berry-circle/server/internal/repository/integrations"
	runsrepo "github.com/laravel42/berry-circle/server/internal/repository/runs"
	"github.com/laravel42/berry-circle/server/internal/secrets"
	"github.com/laravel42/berry-circle/server/internal/service/adkruntime"
	"github.com/laravel42/berry-circle/server/internal/service/automationrun"
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
			MaxIdleConns:        64,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
			// A non-streaming chat completion sends its headers only when the
			// whole reply is ready, so the header timeout must cover a model turn
			// (the client bounds chat calls at five minutes); metadata calls stay
			// bounded by their own 30 s request context.
			ResponseHeaderTimeout: 5 * time.Minute,
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
	var integrationCredentials *integrationrepo.Repository
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
		integrationCredentials = credentials
		logger.Info("repository context enabled for runs")
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

	// Issue runs a workflow step admits go through Temporal too, the way
	// the API's do, rather than through this process's own pool.
	runDispatcher, err := orchestration.NewTemporalDispatcher(temporalClient, cfg.TemporalTaskQueue)
	if err != nil {
		logger.Error("temporal dispatcher setup failed", "error", err)
		return 1
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
		Dispatcher:    runDispatcher,
		Code:          runCode,
		Rejections:    runStore,
		Comments:      commentStore,
		Logger:        logger,
		// Writes agent.started/completed/failed beside the run facts so
		// workflows can trigger on them from either dispatch path.
		AgentEvents: runStore,
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
	// The attachments ledger: what a run produced, read by workflow steps
	// that wait on an agent run and written by the promoter below.
	artifactStore, err := collaborationrepo.New(pool)
	if err != nil {
		logger.Error("collaboration repository setup failed", "error", err)
		return 1
	}
	// Artifact promotion (ADR-0006). Both dependencies are optional: without a
	// mounted runtime volume the promoter reports itself disabled and the
	// activity is a no-op, which is what a deployment did before this existed.
	var (
		promoter     *artifacts.Promoter
		artifactRuns orchestration.RunArtifactSource
		// Held beyond the block below so the auto reviewer can read what
		// promotion stored.
		artifactStorage storage.Backend
	)
	if cfg.RuntimeWorkspaceRoot != "" {
		backend, err := storage.NewWithContext(ctx, storage.Config{
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
		artifactStorage = backend
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
		// Files the agent writes reach the issue from the stream as well, so a
		// write the runtime dropped still lands.
		dispatcher.SetArtifacts(promoter)
		logger.Info("artifact promotion enabled", "root", cfg.RuntimeWorkspaceRoot)

		// The handoff between agents, reading the same store promotion writes.
		// OpenFang gives every agent a private workspace and no way to read
		// another's, so what one run produced reaches the next through the
		// prompt rather than through a shared directory. Gated with promotion
		// because there is nothing to hand over until runs are promoted.
		dispatcher.SetHandoff(priorwork.Builder{
			Source: dependencyArtifacts{store: runStore},
			Reader: artifactStorage,
			Budget: priorwork.DefaultBudget,
		})
		logger.Info("dependency handoff enabled for runs")

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

	// Workflow runs (P1b). The activities drive the same runner the API's
	// in-process starter drives, over the same stores, so the two execution
	// paths cannot drift; only the step executors' wall clock differs.
	automationStore, err := automationrepo.New(pool)
	if err != nil {
		logger.Error("automation store setup failed", "error", err)
		return 1
	}
	approvalStore, err := approvalrepo.New(pool)
	if err != nil {
		logger.Error("approval store setup failed", "error", err)
		return 1
	}
	goalStore, err := goalrepo.New(pool)
	if err != nil {
		logger.Error("goal store setup failed", "error", err)
		return 1
	}
	providerRegistry := integrationcore.NewRegistry()
	for _, provider := range append(providers.All(), providers.Berry{}) {
		if err := providerRegistry.Register(provider); err != nil {
			logger.Error("integration provider registration failed", "error", err)
			return 1
		}
	}
	var toolAuthorizer integrationcore.Authorizer
	if integrationCredentials != nil {
		toolAuthorizer = integrationcore.PermissionAuthorizer{
			Grants:      integrationCredentials,
			Connections: integrationCredentials,
		}
	}
	directory := automationrun.Directory{Pool: pool}
	runner, err := automationrun.New(automationrun.Options{
		Store:              automationStore,
		Issues:             commentStore,
		Approvals:          approvalStore,
		Goals:              goalStore,
		IssueRuns:          dispatcher,
		Artifacts:          artifactStore,
		Responder:          upstream,
		Agents:             directory,
		Boards:             directory,
		Registry:           providerRegistry,
		Authorizer:         toolAuthorizer,
		Broadcaster:        broadcaster,
		Clock:              time.Now,
		NewID:              uuid.New,
		Logger:             logger,
		InlineAgentTimeout: cfg.AutomationInlineAgentTimeout,
	})
	if err != nil {
		logger.Error("automation runner setup failed", "error", err)
		return 1
	}
	// Child runs of subworkflow steps executed on this worker start their
	// own orchestration through the same Temporal client.
	subrunStarter, err := orchestration.NewAutomationStarter(temporalClient, cfg.TemporalTaskQueue)
	if err != nil {
		logger.Error("automation subrun starter setup failed", "error", err)
		return 1
	}
	runner.SetSubrunStarter(subrunStarter)

	// AutoGate: a plan may let its issues close on a peer agent's review. The
	// review is one recorded ask on the runtime's chat route, so it needs the
	// runtime and the pool and nothing else.
	// The reviewer calls its own model directly. OpenFang's chat route
	// forwarded the same request to the same provider and added a hop, an
	// agent-name indirection Berry no longer needs, and a dependency the ADK
	// runtime otherwise removed.
	autoReview := &autogate.Service{
		Store: autogate.PostgresStore{Pool: pool},
		Chat: openrouter.New("", nil,
			openrouter.WithAPIKey(cfg.OpenRouterAPIKey),
			// A review is one question against a model that may reason for a
			// while; the planner's own bound is the closest thing Berry has to
			// a house limit on that.
			openrouter.WithChatTimeout(cfg.PlannerTimeout),
		),
		Clock:  time.Now,
		NewID:  uuid.New,
		Logger: logger,
	}
	// The reviewer reads the artifacts rather than being told their names: it
	// is sandboxed to its own workspace and cannot check the author's.
	if artifactStorage != nil {
		autoReview.Files = artifactStorage
	}

	// Agent execution moves to the TypeScript server when configured, while
	// admission and cancellation stay here: those are Berry's bookkeeping and
	// have nothing to do with which runtime an agent runs in.
	var runDispatch orchestration.RunDispatcher = dispatcher
	if cfg.AgentRuntime == "adk" {
		runtime, runtimeErr := adkruntime.New(adkruntime.Options{
			BaseURL: cfg.AgentRuntimeURL,
			Token:   cfg.AgentRuntimeToken,
			Store:   runStore,
			Clock:   time.Now,
			NewID:   uuid.New,
			Logger:  logger,
		})
		if runtimeErr != nil {
			logger.Error("agent runtime setup failed", "error", runtimeErr)
			return 1
		}
		runDispatch = adkruntime.Redirect(dispatcher, runtime)
		logger.Info("agent runtime selected", "runtime", "adk", "url", cfg.AgentRuntimeURL)
	}

	activities, err := orchestration.NewActivities(orchestration.Activities{
		Intake:          intakeStore,
		Runs:            runDispatch,
		ActorID:         actorID,
		Clock:           time.Now,
		NewID:           uuid.New,
		Artifacts:       promoter,
		ArtifactRuns:    artifactRuns,
		Delivery:        runDeliveries,
		AutoReview:      autoReview,
		DeliverableRuns: deliverableRows,
		Automations:     runner,
		AutomationRuns:  automationStore,
		ScheduledRuns:   automationStore,
		Logger:          logger,
	})
	if err != nil {
		logger.Error("orchestration activities setup failed", "error", err)
		return 1
	}

	w := worker.New(temporalClient, cfg.TemporalTaskQueue, worker.Options{
		// Activity slots bound how many agent streams this worker holds open,
		// which is a provider-spend ceiling as much as a memory one. Workflow
		// step activities share the queue, so they get their own share of
		// slots rather than starving the agent streams.
		MaxConcurrentActivityExecutionSize: cfg.IntakeMaxConcurrent + cfg.AutomationMaxConcurrent,
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
		"automationMaxConcurrent", cfg.AutomationMaxConcurrent,
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

// dependencyArtifacts adapts the run repository to the handoff builder.
type dependencyArtifacts struct {
	store *runsrepo.Repository
}

func (adapter dependencyArtifacts) DependencyArtifacts(
	ctx context.Context,
	issueID uuid.UUID,
	limit int,
) ([]priorwork.Artifact, error) {
	rows, err := adapter.store.DependencyArtifacts(ctx, issueID, limit)
	if err != nil {
		return nil, err
	}
	found := make([]priorwork.Artifact, 0, len(rows))
	for _, row := range rows {
		found = append(found, priorwork.Artifact{
			IssueIdentifier: row.IssueIdentifier,
			IssueTitle:      row.IssueTitle,
			AgentName:       row.AgentName,
			FileName:        row.FileName,
			ContentType:     row.ContentType,
			SizeBytes:       row.SizeBytes,
			StorageKey:      row.StorageKey,
		})
	}
	return found, nil
}
