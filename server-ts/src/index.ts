import { serve } from '@hono/node-server';

/**
 * The build, for `berry_build_info` and nothing else.
 *
 * Read from the environment rather than from `package.json`: a container built
 * from a commit knows which commit it was, and the manifest's version only
 * changes when someone remembers to change it.
 */
const VERSION = (process.env.BERRY_VERSION ?? '').trim() || '0.1.0-dev';
/**
 * How long a plugin MCP token minted into an envelope lives: no run outlives
 * its AgentCore session, and no session outlives eight hours (runtime-control.ts).
 */
const PLUGIN_MCP_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

import { loadConfig } from './config/config.ts';
import { checkDatabase, closeDatabase, openDatabase } from './db/pool.ts';
import { createApp } from './http/app.ts';
import { Registry } from './http/registry.ts';
import { platformMounts } from './mounts/platform.ts';
import { authMounts } from './mounts/auth.ts';
import { meMounts } from './mounts/me.ts';
import { workspaceMounts } from './mounts/workspaces.ts';
import { secretsMounts } from './mounts/secrets.ts';
import { boardMounts } from './mounts/boards.ts';
import { issueMounts } from './mounts/issues.ts';
import { commentMounts, issueCommentRoutes } from './mounts/comments.ts';
import { issueRelationRoutes } from './mounts/issue-relations.ts';
import { issueAttachmentRoutes } from './mounts/issue-attachments.ts';
import { artifactMounts, issueArtifactRoutes } from './mounts/artifacts.ts';
import { RunArtifactRepository } from './core/run-artifacts.ts';
import { goalMounts } from './mounts/goals.ts';
import { attachmentMounts } from './mounts/attachments.ts';
import { projectMounts } from './mounts/projects.ts';
import { boardRunRoutes, issueRunRoutes, runMounts } from './mounts/runs.ts';
import { integrationMounts } from './mounts/integrations.ts';
import { PlanTriage } from './plans/triage.ts';
import { createScm } from './scm/provider-factory.ts';
import { ScmInbound } from './scm/inbound.ts';
import { WebhookDeliveries } from './scm/webhook.ts';
import { webhookMounts } from './mounts/webhooks.ts';
import { githubMounts } from './mounts/github.ts';
import { GitHubEvents } from './scm/github-events.ts';
import { GitHubSettingsRepository, writeWorkspaceEvent } from './scm/github-settings.ts';
import { PullRequestStore } from './scm/pull-requests.ts';
import { approvalMounts } from './mounts/approvals.ts';
import { inboxMounts } from './mounts/inbox.ts';
import { workspaceReadMounts } from './mounts/workspace-reads.ts';
import { issueTrackingRoutes } from './mounts/issue-tracking.ts';
import { commentTrackingRoutes } from './mounts/comment-tracking.ts';
import { workCatalogRoutes } from './mounts/work-catalogs.ts';
import { savedViewRoutes } from './mounts/view-routes.ts';
import { pinMounts } from './mounts/pins.ts';
import { joinLinkMounts } from './mounts/join-links.ts';
import { workTrackingHooks } from './work/hooks.ts';
import { stageGate } from './work/hierarchy.ts';
import { accountRoutes } from './mounts/account.ts';
import { conversationMounts } from './mounts/conversations.ts';
import { editorMounts } from './mounts/editor.ts';
import { EditorAssist } from './editor/assist.ts';
import { RuntimeCompletion } from './runtime/completion.ts';
import { planMounts } from './mounts/plans.ts';
import { PlanAnswerRepository } from './plans/answers.ts';
import { PlanRepository } from './plans/repository.ts';
import { PlanGenerator } from './plans/generator.ts';
import { ConversationRepository } from './conversations/repository.ts';
import { InboxRepository } from './inbox/repository.ts';
import { ApprovalRepository } from './approvals/repository.ts';
import { OAuthStateStore } from './integrations/oauth.ts';
import { RunRepository } from './runs/repository.ts';
import { RunLedger } from './runs/ledger.ts';
import { Dispatcher } from './runs/dispatcher.ts';
import {
   agentCompletion,
   agentEnqueue,
   autopilotEnqueue,
   quickActionEnqueue,
   registerDelegateTool,
} from './runtime/wiring.ts';
import { AutopilotRepository } from './autopilots/repository.ts';
import { fireAutopilot, type FireInput } from './autopilots/fire.ts';
import { resolveSquadLeader } from './autopilots/squads.ts';
import { autopilotMounts } from './mounts/autopilots.ts';
import { autopilotWebhookMounts } from './mounts/autopilot-webhooks.ts';
import { AutopilotScheduler } from './runs/scheduler.ts';
import { commentTriggers } from './agents/triggers.ts';
import { registerChatReplies } from './conversations/chat-tasks.ts';
import { registerSquadRetrigger } from './squads/retrigger.ts';
import { AgentCoreIdentity } from './agentcore/identity.ts';
import { agentMounts } from './mounts/agents.ts';
import { usageMounts } from './mounts/usage.ts';
import { PriceBook } from './agents/pricing.ts';
import { configureUsagePricing, recordTaskUsage } from './usage/record.ts';
import { eventMounts } from './mounts/events.ts';
import { IdentityRepository } from './identity/repository.ts';
import { WorkspaceRepository } from './identity/workspaces.ts';
import { SecretsRepository } from './identity/secrets.ts';
import { BoardRepository } from './core/boards.ts';
import { IssueRepository } from './core/issues.ts';
import { CommentRepository } from './core/comments.ts';
import { DependencyRepository } from './core/dependencies.ts';
import { ReviewRepository } from './core/reviews.ts';
import { GoalRepository } from './core/goals.ts';
import { createGoalLinker } from './core/goal-linker.ts';
import { AttachmentRepository } from './core/attachments.ts';
import { ProjectRepository } from './core/projects.ts';
import { Hub } from './realtime/hub.ts';
import { Distributed } from './realtime/distributed.ts';
import { ReplayRepository } from './realtime/replay.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { SessionService } from './auth/sessions.ts';
import { personalTokenResolver } from './auth/credentials.ts';
import { PluginRuntimeStore } from './plugins/runtime-store.ts';
import { publicApiMounts } from './mounts/public-api.ts';
import { PluginRepository } from './plugins/repository.ts';
import { createPluginNetwork } from './plugins/net.ts';
import { pluginMounts } from './mounts/plugins.ts';
import { PluginCaller, PluginHookRunner } from './plugins/hooks.ts';
import pg from 'pg';
import { devSessionCookies } from './auth/better-auth.ts';
import { AuthProvider } from './auth/auth-provider.ts';
import { FirstRunSetup, databaseWorld } from './auth/first-run-setup.ts';
import { betterAuthMounts } from './mounts/better-auth.ts';
import { Storage } from './storage/storage.ts';
import { ReviewGate } from './agents/review-gate.ts';
import { ReviewQueue } from './core/review-queue.ts';
import { reviewMounts } from './mounts/reviews.ts';
import { GitHubClient } from './integrations/github.ts';
import { AgentRepository } from './agents/repository.ts';
import { ModelCatalog } from './agents/catalog.ts';
import { createLogger } from './observability/log.ts';
import { AgentCoreRunMemory, nullRunMemory } from './agentcore/memory.ts';
import { agentToolMounts } from './runtime/agent-tools/mount.ts';
import { agentCoreTransport } from './runtime/agentcore-transport.ts';
import { EnvelopeBuilder } from './runtime/envelope-builder.ts';
import { httpTransport } from './runtime/http-transport.ts';
import { RuntimeTaskExecutor, type UsageRecorder } from './runtime/task-executor.ts';
import { routingTransport, type RuntimeTarget } from './runtime/transport.ts';
import { runtimeMounts } from './mounts/runtimes.ts';
import { syncPlatformRuntime } from './runtime/runtimes.ts';
import { applyLifecycle } from './runtime/runtime-control.ts';
import { agentCoreRuntimeDriver } from './execution/agentcore-runtime.ts';
import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { ConnectionRepository } from './integrations/connections.ts';
import { GitHubAppRepository } from './integrations/github-app.ts';
import { sealerFromKey, unavailableSealer } from './integrations/sealing.ts';
import { agentAccessGuard } from './agents/access.ts';
import { AgentBuilder } from './agents/builder.ts';
import { AgentProfileRepository } from './agents/profile.ts';
import { McpServerRepository } from './mcp/repository.ts';
import { agentBuilderMounts } from './mounts/agent-builder.ts';
import { mcpServerMounts } from './mounts/mcp-servers.ts';
import { skillMounts } from './mounts/skills.ts';
import { squadMounts } from './mounts/squads.ts';
import { importFromGitHub } from './skills/github-import.ts';
import { SkillRepository } from './skills/repository.ts';
import { SquadRepository } from './squads/repository.ts';

/**
 * The composition root.
 *
 * Domain modules contribute mounts and this file is the only place that knows
 * about all of them, which is why no module imports every handler.
 */

const config = loadConfig();
const logger = createLogger(config.serviceName);
const sql = openDatabase({ url: config.databaseUrl });

/**
 * Sign-in, when this deployment has a secret to sign cookies with and an
 * origin to send the browser back to. Without them the server still serves
 * API clients on personal access tokens; the browser just cannot sign in.
 */
const authPool =
   config.auth.secret && config.auth.baseUrl
      ? new pg.Pool({ connectionString: config.databaseUrl, max: 5 })
      : null;

/**
 * The App this deployment created for itself.
 *
 * Declared here, before sign-in, because sign-in reads its credentials: the
 * OAuth half of the App is what a person signs in with, and it lives in the
 * database rather than in this process's environment. Its secrets are sealed
 * with the same key a connection's token is — a deployment that cannot seal
 * cannot hold a private key either.
 */
const githubApp = config.integrationKey
   ? new GitHubAppRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

/**
 * Sign-in, built on first use rather than here.
 *
 * The credentials come from the App above when there is one, and from
 * `BERRY_AUTH_GITHUB_*` only for a deployment that still sets them. The App is
 * created from the browser while this process is running, so an instance built
 * at boot would be built without it and the person who had just created the App
 * would have to restart the server to use it.
 */
const authProvider =
   authPool && config.auth.secret && config.auth.baseUrl
      ? new AuthProvider({
           pool: authPool,
           secret: config.auth.secret,
           baseUrl: config.auth.baseUrl,
           trustedOrigins: config.auth.trustedOrigins,
           sessionTtlMs: config.sessionTtlMs,
           testUtils: config.auth.devLogin,
           fallback: config.auth.github,
           stored: githubApp
              ? {
                   fingerprint: () => githubApp.signInFingerprint(),
                   credentials: () => githubApp.clientCredentials(),
                }
              : null,
           // Logged as a failure, never with its value: the only thing that can
           // go wrong here is a sealing key that does not open the row.
           onError: (error) =>
              logger.error('the stored GitHub App credentials could not be read', {
                 error: error instanceof Error ? error.message : String(error),
              }),
        })
      : null;

/**
 * How the first person ever to open this deployment creates the App.
 *
 * Only where an App can be stored at all, and only while there is neither an App
 * nor a user — the token below is printed at boot and stops working the moment
 * either exists.
 */
const firstRunSetup = githubApp ? new FirstRunSetup({ world: databaseWorld(sql) }) : null;

const sessions = new SessionService({
   sql,
   auth: authProvider ? { getSession: ({ headers }) => authProvider.getSession({ headers }) } : null,
   bearer: [personalTokenResolver(sql)],
   trustedOrigins: config.auth.trustedOrigins,
});

const identity = new IdentityRepository(sql);
const workspaces = new WorkspaceRepository(sql);
const secrets = new SecretsRepository(sql);
const boards = new BoardRepository(sql);
const issues = new IssueRepository(sql);
const runArtifacts = new RunArtifactRepository(sql);
const comments = new CommentRepository(sql);
const dependencies = new DependencyRepository(sql);
const reviews = new ReviewRepository(sql);
const goals = new GoalRepository(sql);
const attachments = new AttachmentRepository(sql);
const projects = new ProjectRepository(sql);
const agents = new AgentRepository(sql);
// Plugin tokens, storage and the invocation log. Needs no key: nothing it
// holds is a secret in the clear (tokens are digests).
const pluginRuntime = new PluginRuntimeStore({ sql });

// A hub with no relay for now: this process delivers to its own subscribers.
// The Valkey relay is wired when the SSE endpoints land, so a subscriber
// exists to receive what other nodes publish.
const broadcaster = new Distributed(new Hub(config.realtimeBuffer), null);
const idempotency = new IdempotencyStore(sql);

/**
 * Object storage, where an agent's files land. Null when none is configured:
 * the tool API then refuses file writes rather than dropping them.
 */
const storage = config.storage
   ? new Storage({
        bucket: config.storage.bucket,
        region: config.storage.region,
        ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
        forcePathStyle: config.storage.forcePathStyle,
        ...(config.storage.accessKeyId ? { accessKeyId: config.storage.accessKeyId } : {}),
        ...(config.storage.secretAccessKey
           ? { secretAccessKey: config.storage.secretAccessKey }
           : {}),
        ...(config.storage.sessionToken ? { sessionToken: config.storage.sessionToken } : {}),
        maxBytes: config.storage.maxBytes,
     })
   : null;

/**
 * Run recall, when a Memory store is configured.
 *
 * Null rather than a disabled instance so the executor's own default decides
 * what "no memory" means; `nullRunMemory` is that decision, in one place.
 * Errors are logged and never raised: a store that is unreachable costs an
 * agent its recall, and the run ledger still holds what actually happened.
 */
const runMemory =
   config.agentCore?.memoryId
      ? new AgentCoreRunMemory({
           region: config.agentCore.region,
           memoryId: config.agentCore.memoryId,
           ...(config.agentCore.credentials
              ? { credentials: config.agentCore.credentials }
              : {}),
           onError: (operation, error) =>
              console.error(
                 `[memory] ${operation} failed:`,
                 error instanceof Error ? error.message : error
              ),
        })
      : null;

/**
 * Provider connections, when a key exists to open them with.
 *
 * Null rather than a repository that cannot decrypt: a run then simply never
 * gets a repository, which is a working deployment, instead of one that fails
 * at the clone with a decryption error.
 */
// The issue mount's narrow view of goals: clear an issue's goal, or link it to
// one that belongs to the same workspace. Adapted here (see core/goal-linker)
// so `goalId` on an issue is honoured rather than silently discarded.
const goalLinker = createGoalLinker(sql, goals);

const connections = config.integrationKey
   ? new ConnectionRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

// One sealer for agent-layer secrets (MCP headers, agent env). Without the key
// it refuses every seal, so nothing can be stored in the clear by accident.
const agentSealer = config.integrationKey
   ? sealerFromKey(config.integrationKey)
   : unavailableSealer('INTEGRATION_ENCRYPTION_KEY is not set');
const skillRepository = new SkillRepository(sql);
const mcpRepository = new McpServerRepository({ sql, sealer: agentSealer });
const agentProfiles = new AgentProfileRepository({ sql, sealer: agentSealer });
const squadRepository = new SquadRepository(sql);

// The App's own credentials are sealed with the same key, for the same reason:
// a deployment that cannot seal cannot hold a private key either.
// Plugins hold sealed secrets and a sealed signing key, so they need the same
// key integrations do. Without it the mount answers PLUGINS_NOT_CONFIGURED.
const pluginRepository = config.integrationKey
   ? new PluginRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;
const pluginNetwork = createPluginNetwork({ allowPrivate: config.pluginsAllowPrivateNetwork });

/**
 * The git host, which is GitHub.
 *
 * The provider is chosen and the SCM services assembled by `createScm` (see
 * scm/provider-factory): `agentcore` reaches GitHub through the gateway's
 * tools, the App path uses Berry's own client and a per-workspace installation
 * token, and both satisfy `ScmProvider` so nothing in the domain can tell. All
 * pieces are null when nothing is configured — a working deployment that just
 * cannot reach a git host. Awaited because gateway tool discovery runs at boot.
 */
const scm = await createScm({ sql, config, logger, githubApp });
const scmWorkspaces = scm.workspaces;
const scmSync = scm.sync;
/**
 * GitHub parity (workstream K): the workspace's switches, the pull requests
 * linked to its issues, and the webhook handler that feeds them. A webhook is
 * routed to the workspace that claimed its installation, and to no other.
 */
const githubSettings = new GitHubSettingsRepository(sql);
const pullRequests = new PullRequestStore({ sql, issues });
const workspaceForInstallation = async (installationId: number): Promise<string | null> =>
   githubApp ? githubApp.claimedBy(installationId) : null;
const scmInbound = new ScmInbound({
   sql,
   links: scm.links,
   logger,
   // Reviews and runs are matched by branch, which only one workspace's
   // installation may reach.
   workspaceForInstallation,
   github: new GitHubEvents({
      workspaceForInstallation,
      settings: githubSettings,
      pullRequests,
      removeInstallation: async (installationId) =>
         githubApp ? githubApp.removeInstallationById(installationId) : null,
      publishConnection: (workspaceId) =>
         writeWorkspaceEvent(sql, {
            workspaceId,
            type: 'github.connection.updated',
            aggregateType: 'github_installation',
            aggregateId: workspaceId,
            payload: { installed: false },
         }),
   }),
});

/**
 * The one completion client the single-call callers share. Each call is a
 * `kind: 'completion'` task on the runtime (ADR-0014): the server holds no
 * model client, so there is no credential to plumb here.
 */
const completion = new RuntimeCompletion({
   sql,
   // Declared further down; called only at request time, after boot.
   nudge: () => dispatcher?.nudge(),
   defaultModel: config.runtime.defaultModel,
});

/** The agent layer's single model calls, as completion tasks on the runtime. */
const complete = agentCompletion({
   sql,
   nudge: () => dispatcher?.nudge(),
   defaultModel: config.runtime.defaultModel,
});

/**
 * Where an agent's gateway-routed MCP servers go: the AgentCore Gateway, with
 * the workload identity's headers. Null without a gateway, and such servers
 * are then left out of the task rather than sent direct.
 */
const gatewayRoute = config.agentCoreGateway
   ? (() => {
        const gateway = config.agentCoreGateway;
        const identity = new AgentCoreIdentity({
           region: gateway.region,
           providerName: gateway.githubProviderName,
           workloadName: gateway.workloadName,
        });
        return { url: gateway.gatewayUrl, headers: () => identity.gatewayHeaders() };
     })()
   : null;

/**
 * AutoGate: a peer agent reviews what a run delivered, for tasks whose plan
 * opted in — and on request for any task with a pull request. Needs the same
 * credential runs do (to read the diff) and the same completion the planner
 * uses (to decide).
 */
/**
 * Where tasks run (ADR-0014). The configured AgentCore Runtime by ARN when
 * there is one, else the same image on a URL (the local agent-runtime
 * service). A workspace's registered runtimes override it per agent.
 */
const defaultTarget: RuntimeTarget | null = config.agentCore?.runtimeArn
   ? {
        id: null,
        driver: 'agentcore',
        arn: config.agentCore.runtimeArn,
        qualifier: 'DEFAULT',
        region: config.agentCore.region,
        endpointUrl: null,
     }
   : config.runtime.agentRuntimeUrl
     ? {
          id: null,
          driver: 'http',
          arn: null,
          qualifier: 'DEFAULT',
          region: null,
          endpointUrl: config.runtime.agentRuntimeUrl,
       }
     : null;

/**
 * AutoGate: a peer agent reviews what a run delivered, for tasks whose plan
 * opted in — and on request for any task with a pull request. Its decision is
 * a completion task, so it exists wherever tasks can run.
 */
const reviewGate = defaultTarget
   ? new ReviewGate({
        sql,
        issues,
        runs: new RunRepository(sql),
        completion,
        defaultModel: config.runtime.defaultModel,
        maxAttempts: config.agents?.autoGateMaxAttempts ?? 2,
        github: async (workspaceId) =>
           new GitHubClient({ token: (await scm.gitCredential(workspaceId)).password }),
        onError: (message, error) =>
           logger.error(message, { error: error instanceof Error ? error.message : String(error) }),
     })
   : null;

/**
 * Token usage the runtime reports on `task.usage`, stored and priced by
 * workstream C's `recordTaskUsage`. The assignment is the compile-time proof
 * that the runtime's report and C's input agree.
 */
const recordUsage: UsageRecorder = recordTaskUsage;

const transport = routingTransport({
   agentcore: config.agentCore
      ? agentCoreTransport({
           region: config.agentCore.region,
           ...(config.agentCore.credentials ? { credentials: config.agentCore.credentials } : {}),
        })
      : null,
   http: httpTransport(),
});

const executor = defaultTarget
   ? new RuntimeTaskExecutor({
        sql,
        transport,
        defaultTarget,
        recordUsage,
        builder: new EnvelopeBuilder({
           sql,
           publicUrl:
              config.runtime.callbackUrl ??
              config.integrations.publicUrl ??
              `http://${config.apiAddr.host}:${config.apiAddr.port}`,
           defaultModel: config.runtime.defaultModel,
           memory: runMemory ?? nullRunMemory(),
           sealer: config.integrationKey ? sealerFromKey(config.integrationKey) : null,
           ...(scm.provisioning ? { gitCredential: scm.gitCredential } : {}),
           github: (token) => new GitHubClient({ token }),
           extensions: { skills: skillRepository, mcp: mcpRepository, profile: agentProfiles, gateway: gatewayRoute },
           // Plugin tools need the sealing key: without it no plugin is installed.
           ...(pluginRepository
              ? { plugins: { plugins: pluginRepository, runtime: pluginRuntime, ttlMs: PLUGIN_MCP_TOKEN_TTL_MS } }
              : {}),
           onSkipped: (names) => logger.warn('mcp server skipped: no gateway', { names }),
        }),
        memory: runMemory ?? nullRunMemory(),
        ...(scm.provisioning ? { gitCredential: scm.gitCredential } : {}),
        github: (token) => new GitHubClient({ token }),
        ...(reviewGate ? { reviewGate } : {}),
        onGateError: (error) =>
           logger.error('peer review failed', {
              error: error instanceof Error ? error.message : String(error),
           }),
        onUsageError: (error) =>
           logger.error('usage was not recorded', {
              error: error instanceof Error ? error.message : String(error),
           }),
        tokenTtlSeconds: config.runtime.tokenTtlSeconds,
     })
   : null;

// Every workspace sees the deployment's own runtime as a row it can bind
// agents to and probe. A failure here costs the listing, never the boot.
await syncPlatformRuntime(sql, defaultTarget).catch((error: unknown) =>
   logger.error('could not sync the platform runtime', {
      error: error instanceof Error ? error.message : String(error),
   })
);

// The model picker's catalogue. Null without a credential rather than an
// empty list: "no models exist" and "this server cannot ask" are different
// answers, and only one of them is true.
const modelCatalog = config.agents
   ? new ModelCatalog({
        region: config.agents.region,
        ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
     })
   : null;

// Usage is priced on write from the same open feed the model picker reads.
// Not gated on agent config: runs executed elsewhere still report usage here.
configureUsagePricing(new PriceBook());

// Reading the ledger, and admitting a run. The executor builds its own ledger
// per run because it writes as the run happens; this one is for the request
// path, which only reads and cancels.
const runOptions = {
   sessions,
   runs: new RunRepository(sql),
   ledger: new RunLedger({ sql }),
   issues,
   boards,
   idempotency,
};

const registry = new Registry();
registry.registerAll(meMounts({ sessions, identity, nested: accountRoutes({ boards, sql }) }));
registry.registerAll(workspaceMounts({ sessions, workspaces, secrets }));
registry.registerAll(secretsMounts({ sessions, secrets }));
registry.registerAll(
   boardMounts({ sessions, boards, idempotency, nested: boardRunRoutes(runOptions) })
);
// Work tracking: subscriptions and inbox rows after writes, and the stage
// barrier on sub-issues. Dispatch only where runs can execute, as below.
const workDispatch = executor ? runOptions.runs : undefined;
const workHooks = workTrackingHooks({ sql, issues, dispatch: workDispatch });
const commentOptions = {
   sessions,
   comments,
   issues,
   idempotency,
   broadcaster,
   hooks: workHooks,
   extensions: commentTrackingRoutes({ sql, comments, broadcaster }),
   // A person's comment that mentions an agent (or a squad, or replies to the
   // assignee) queues a task for it.
   triggers: commentTriggers({
      sql,
      enqueue: agentEnqueue,
      report: (error: unknown) =>
         logger.error('comment trigger failed', { error: error instanceof Error ? error.message : String(error) }),
   }),
};
registry.registerAll(
   issueMounts({
      scm: scmSync,
      // Without this, `goalId` on a create or patch is accepted and silently
      // does nothing — and a task then reaches the git host with no milestone.
      goals: goalLinker,
      sessions,
      issues,
      boards,
      idempotency,
      broadcaster,
      // Who may hand work to which agent (an agent's assign scope).
      agentAccess: agentAccessGuard(sql),
      nested: issueCommentRoutes(commentOptions),
      relations: issueRelationRoutes({ issues, dependencies, reviews, gate: reviewGate }),
      runs: issueRunRoutes(runOptions),
      // A task handed to an agent starts on its own. Only where runs can
      // execute: without an executor a queued run would sit forever.
      ...(executor ? { dispatch: runOptions.runs } : {}),
      stages: stageGate(sql),
      hooks: workHooks,
      // Quick actions queue through the runtime's task queue.
      tracking: issueTrackingRoutes({
         sql,
         issues,
         boards,
         comments,
         broadcaster,
         dispatch: workDispatch,
         hooks: workHooks,
         enqueue: quickActionEnqueue,
      }),
      artifacts: issueArtifactRoutes({ artifacts: runArtifacts, issues }),
      attachments: issueAttachmentRoutes({
         attachments,
         issues,
         storage,
         // Without storage there is no cap to enforce, because there is
         // nowhere to put a file; the route answers 503 before it reads one.
         maxBytes: config.storage?.maxBytes ?? 0,
      }),
   })
);
registry.registerAll(commentMounts(commentOptions));
registry.registerAll(
   publicApiMounts({
      personalTokens: personalTokenResolver(sql),
      sql,
      issues,
      comments,
      plugins: pluginRuntime,
      broadcaster,
   })
);
registry.registerAll(
   pluginMounts({
      sessions,
      sql,
      plugins: pluginRepository,
      runtime: pluginRuntime,
      network: pluginNetwork,
      publicUrl: config.integrations.publicUrl,
   })
);
// Plugin hooks run in every server process; the cursor and schedule rows are
// claimed with SKIP LOCKED, so two processes never deliver the same thing.
const pluginHooks = pluginRepository
   ? new PluginHookRunner({
        sql,
        plugins: pluginRepository,
        caller: new PluginCaller({
           plugins: pluginRepository,
           runtime: pluginRuntime,
           network: pluginNetwork,
           publicUrl: config.integrations.publicUrl,
        }),
        onError: (message, error) =>
           logger.error(message, { error: error instanceof Error ? error.message : String(error) }),
     })
   : null;
pluginHooks?.start();

/**
 * Autopilots. Always served: reading and editing them needs no model
 * credential. A webhook trigger needs the encryption key for its signing
 * secret, and without one the create answers 412 rather than storing a
 * secret in the clear.
 */
const autopilots = new AutopilotRepository({
   sql,
   sealer: config.integrationKey
      ? sealerFromKey(config.integrationKey)
      : unavailableSealer('INTEGRATION_ENCRYPTION_KEY is not set'),
});
const fireAutopilotNow = (input: FireInput) =>
   fireAutopilot({ sql, issues, enqueue: autopilotEnqueue, resolveSquadLeader }, input);
registry.registerAll(autopilotMounts({ sessions, sql, autopilots, fire: fireAutopilotNow, idempotency }));
registry.registerAll(autopilotWebhookMounts({ autopilots, fire: fireAutopilotNow, logger }));
registry.registerAll(
   webhookMounts({
      inbound: scmInbound,
      deliveries: new WebhookDeliveries(sql),
      secret: config.git?.webhookSecret ?? null,
      // The secret GitHub issued with the App, so a manifest-created App's
      // deliveries verify without an operator copying it into the environment.
      secrets: async () => [githubApp ? await githubApp.webhookSecret() : null],
      logger,
   })
);
registry.registerAll(
   goalMounts({ sessions, goals, issues, idempotency, broadcaster, scm: scmSync })
);
registry.registerAll(attachmentMounts({ sessions, attachments, storage }));
registry.registerAll(artifactMounts({ sessions, artifacts: runArtifacts, issues, storage }));
registry.registerAll(
   projectMounts({
      sessions,
      projects,
      idempotency,
      scm: scm.provisioning,
      scmWorkspaces,
      connections,
      githubApp,
      logger,
   })
);
registry.registerAll(runMounts(runOptions));
// Berry's tools for a running task, behind its task token (not a session).
registry.registerAll(agentToolMounts({ sql, storage, issues, projects }));
const agentCore = config.agentCore;
registry.registerAll(
   runtimeMounts({
      sessions,
      sql,
      sealer: config.integrationKey ? sealerFromKey(config.integrationKey) : null,
      defaultTarget,
      health: async (target) => {
         if (target.driver === 'http') {
            const response = await fetch(`${(target.endpointUrl ?? '').replace(/\/+$/, '')}/ping`, {
               signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) throw new Error(`the runtime answered ${response.status}`);
            return;
         }
         if (!target.arn || !agentCore) throw new Error('AgentCore is not configured');
         await agentCoreRuntimeDriver({
            region: target.region ?? agentCore.region,
            runtimeArn: target.arn,
            qualifier: target.qualifier,
            ...(agentCore.credentials ? { credentials: agentCore.credentials } : {}),
         }).health();
      },
      // Only with AgentCore: a profile's idle timeout is a runtime setting.
      ...(agentCore
         ? {
              applyLifecycle: (arn: string, lifecycle: { idleRuntimeSessionTimeout: number; maxLifetime: number }) =>
                 applyLifecycle(
                    new BedrockAgentCoreControlClient({
                       region: agentCore.region,
                       ...(agentCore.credentials ? { credentials: agentCore.credentials } : {}),
                    }),
                    arn,
                    lifecycle
                 ),
           }
         : {}),
   })
);
registry.registerAll(
   reviewMounts({
      sessions,
      boards,
      queue: new ReviewQueue(sql),
      // The same credential runs clone with; null when no git host is
      // configured, in which case the list still serves and the diff says so.
      gitCredential: scm.provisioning ? scm.gitCredential : null,
   })
);
registry.registerAll(inboxMounts({ sessions, inbox: new InboxRepository(sql), boards }));
registry.registerAll(
   workspaceReadMounts({
      sessions,
      sql,
      boards,
      catalogExtensions: workCatalogRoutes(),
      viewExtensions: savedViewRoutes({ sql }),
   })
);
registry.registerAll(pinMounts({ sessions, sql }));
registry.registerAll(joinLinkMounts({ sessions, sql }));
registry.registerAll(
   planMounts({
      sessions,
      plans: new PlanRepository(sql),
      answers: new PlanAnswerRepository(sql),
      // Reading a plan works without a model credential; only generating one
      // needs it, and a null generator answers PLANNER_UNAVAILABLE rather
      // than opening a plan nothing will ever fill in.
      generator:
         executor
         ? new PlanGenerator({
              sql,
              completion,
              defaultModel: config.runtime.defaultModel,
              maxRepairs: config.agents?.maxRepairs ?? 2,
              maxCriticRounds: config.agents?.maxCriticRounds ?? 1,
           })
         : null,
      // Routing needs the same credential planning does: it is the
      // orchestrator reading the roster and deciding, not a lookup table.
      triage:
         executor
         ? new PlanTriage({
              sql,
              completion,
              defaultModel: config.runtime.defaultModel,
           })
         : null,
      // Its own repository rather than the request path's: a routed task is
      // admitted outside any request, after the response has gone.
      runs: new RunRepository(sql),
      boards,
      idempotency,
      sql,
      logger,
   })
);
const conversationRepository = new ConversationRepository(sql);
// Once per process: a finished chat task posts its reply into the session,
// and a member finishing delegated work wakes its squad leader. Both hook the
// ledger's terminal notification.
registerChatReplies({ sql, conversations: conversationRepository });
registerSquadRetrigger({ sql, enqueue: agentEnqueue });
registerDelegateTool({ sql, issues });
registry.registerAll(
   conversationMounts({
      sessions,
      conversations: conversationRepository,
      boards,
      sql,
      // Chat runs as agent tasks through the runtime's queue.
      enqueue: agentEnqueue,
      complete,
      ledger: runOptions.ledger,
      runs: runOptions.runs,
      logger,
   })
);
registry.registerAll(
   editorMounts({
      sessions,
      assist:
         executor
         ? new EditorAssist({
              completion,
              defaultModel: config.runtime.defaultModel,
           })
         : null,
   })
);
registry.registerAll(
   approvalMounts({
      sessions,
      approvals: new ApprovalRepository(sql),
      boards,
      issues,
      idempotency,
   })
);
registry.registerAll(
   integrationMounts({
      sessions,
      boards,
      connections,
      // The state store needs no key of its own — it holds a hash, not a
      // secret — but a deployment that cannot seal a token cannot finish a
      // handshake either, so the two travel together.
      states: connections ? new OAuthStateStore({ sql }) : null,
      github: config.integrations.github,
      githubApp,
      // Not a secret, and not stored: the App's public name, so an install can
      // be offered on a deployment that signs people in with an App it did not
      // create. A stored App's slug wins.
      appSlug: config.auth.githubAppSlug,
      publicUrl: config.integrations.publicUrl,
      appUrl: config.integrations.appUrl,
      // Settings pages live under the workspace, so a callback needs its slug
      // to send the browser back to a page that exists.
      workspaceSlug: async (workspaceId: string) => {
         const [row] = await sql`SELECT slug FROM workspaces WHERE id = ${workspaceId}`;
         return (row?.slug as string | undefined) ?? null;
      },
      firstRunSetup,
   })
);
registry.registerAll(
   agentMounts({
      sessions,
      agents,
      idempotency,
      catalog: modelCatalog,
      logger,
      runs: runOptions.runs,
      ledger: runOptions.ledger,
      profile: agentProfiles,
   })
);
registry.registerAll(
   skillMounts({
      sessions,
      sql,
      skills: skillRepository,
      idempotency,
      importer: { fromGitHub: (url) => importFromGitHub(url) },
   })
);
registry.registerAll(mcpServerMounts({ sessions, sql, servers: mcpRepository }));
registry.registerAll(
   squadMounts({
      sessions,
      sql,
      squads: squadRepository,
      issues,
      enqueue: agentEnqueue,
      agentAccess: agentAccessGuard(sql),
   })
);
registry.registerAll(
   agentBuilderMounts({
      sessions,
      sql,
      builder: new AgentBuilder({ sql, complete, skills: skillRepository, agents, mcp: mcpRepository }),
   })
);
registry.registerAll(
   githubMounts({ sessions, sql, settings: githubSettings, pullRequests, githubApp, connections })
);
registry.registerAll(usageMounts({ sessions, sql }));
registry.registerAll(
   eventMounts({ sessions, replay: new ReplayRepository(sql), boards, broadcaster })
);
registry.registerAll(
   authMounts({
      sessions,
      sql,
      devSession:
         authProvider && config.auth.devLogin
            ? async (userId) => devSessionCookies(await authProvider.instance(), userId)
            : null,
   })
);
if (authProvider) {
   registry.registerAll(
      betterAuthMounts({ handler: (request) => authProvider.handler(request) })
   );
}
registry.registerAll(
   platformMounts({
      database: () => checkDatabase(sql),
      version: VERSION,
      metrics: {
         sql,
         // Null rather than zero on a server that does not dispatch: "this
         // process runs no runs" and "this process is running none right now"
         // are different facts, and a zero would read as the second.
         inflight: () => dispatcher?.inflight ?? null,
         version: VERSION,
      },
      capabilities: {
         // Reported by whichever server answers, so they have to agree. Only
         // what this process can actually do is true; the rest arrive with the
         // mounts that provide them.
         // True only when a model credential and object storage are both
         // present: this is what the browser uses to decide whether running
         // an agent is offered at all.
         // A model credential and object storage, which is what an agent
         // needs to run at all. Not the dispatcher: a deployment could split
         // serving from dispatching, and this is reported by whichever server
         // answers — so it has to be a property of the build and its
         // configuration rather than of which process was asked.
         agentExecution: executor !== null,
         metrics: true,
         // The event streams are served here now. The relay is not wired, so
         // a fact published by another process arrives on the next poll
         // rather than instantly — later, never lost, because the stream
         // replays from PostgreSQL and Valkey only ever wakes it.
         realtime: true,
         storage: storage !== null,
         valkey: false,
         // The planner runs when there is a model credential to run it with.
         // Planning is a completion task, so it runs wherever tasks do.
         planner: executor !== null,
         // Asked on every read rather than decided here: the App sign-in runs
         // on can be created from the browser a minute from now, and this is
         // what the sign-in page believes.
         githubSignIn: authProvider ? () => authProvider.githubSignIn() : false,
      },
   })
);

/**
 * What turns a queued run into a running one.
 *
 * Only where there is an executor: a server with no model credential can serve
 * the ledger and admit runs, and a dispatcher there would claim work it cannot
 * do and fail every run it touched.
 */
const dispatcher = executor
   ? new Dispatcher({ sql, executor, logger, concurrency: config.runtime.concurrency })
   : null;
dispatcher?.start();

// Schedules fire only where tasks can run: a schedule on a server with no
// dispatcher would queue work nothing takes. Several servers may run this;
// sys_cron_executions lets exactly one fire each slot.
const autopilotScheduler = dispatcher ? new AutopilotScheduler({ sql, fire: fireAutopilotNow, logger }) : null;
autopilotScheduler?.start();

const app = createApp(registry);

const server = serve({ fetch: app.fetch, hostname: config.apiAddr.host, port: config.apiAddr.port });
logger.info('Berry server listening', {
   apiAddr: `${config.apiAddr.host}:${config.apiAddr.port}`,
   environment: config.appEnv,
   // Named at boot so an operator can see where tasks are sent, without
   // reading the environment back.
   agentRuntime: defaultTarget
      ? defaultTarget.driver === 'agentcore'
         ? defaultTarget.arn
         : defaultTarget.endpointUrl
      : 'none',
   // Named at boot because a server that admits runs but does not execute them
   // looks identical from outside until the first one sits queued forever.
   runDispatch: dispatcher ? `${config.runtime.concurrency} at a time` : 'off',
   // Schedules fire beside the dispatcher and nowhere else.
   autopilotSchedules: autopilotScheduler ? 'on' : 'off',
   // Named at boot because recall is invisible from outside: an agent with no
   // memory and an agent whose store is misconfigured both just start fresh.
   runMemory: runMemory ? 'agentcore' : 'off',
   // Named at boot so an operator can see whether a run can reach a
   // repository, without reading the environment back.
   integrations: connections
      ? config.integrations.github && config.integrations.publicUrl
         ? 'github'
         : 'no provider credentials'
      : 'no encryption key',
   // What sign-in can do *now*: the App in the database, the credentials in the
   // environment, or nothing yet — and "nothing yet" is a state someone fixes
   // from the browser rather than from a configuration file.
   signIn: authProvider
      ? (await authProvider.githubSignIn())
        ? config.auth.github && !(await githubApp?.app())
          ? 'github (OAuth App from the environment)'
          : 'github (the App in the database)'
        : 'no GitHub App yet'
      : 'off',
   mounts: registry.prefixes,
});

/**
 * The one-time token that lets the first person set this deployment up.
 *
 * Printed only while there is no GitHub App and nobody with an account: until
 * the App exists there is no way to sign in, and until someone is signed in
 * there is no way to create the App. The token stands in for a session on the
 * App manifest route and on nothing else, it is good once, and it stops working
 * the moment either an App or a user exists. Restarting the server prints a new
 * one, which is what to do if the App is never created.
 */
if (firstRunSetup && (await firstRunSetup.available())) {
   logger.info(
      'nobody has set this deployment up yet. Create the GitHub App from the browser with this one-time setup token, or send it as the x-berry-setup-token header on POST /api/v1/integrations/github/app/manifest. It works once, and only until an App or a user exists.',
      { setupToken: firstRunSetup.token }
   );
}

// Drain on SIGTERM before closing the pool, so a request in flight finishes
// rather than failing at the socket.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.once(signal, () => {
      logger.info('shutting down', { signal });
      server.close(() => {
         // The dispatcher first: it aborts what it is running, and a run left
         // mid-flight is reclaimed from its lease rather than recorded from a
         // process that is on its way out.
         void Promise.all([
            dispatcher ? dispatcher.stop() : Promise.resolve(),
            autopilotScheduler ? autopilotScheduler.stop() : Promise.resolve(),
            pluginHooks ? pluginHooks.stop() : Promise.resolve(),
         ])
            .then(() => closeDatabase(sql))
            .then(() => authPool?.end())
            .then(() => process.exit(0));
      });
   });
}

