import { serve } from '@hono/node-server';

/**
 * The build, for `berry_build_info` and nothing else.
 *
 * Read from the environment rather than from `package.json`: a container built
 * from a commit knows which commit it was, and the manifest's version only
 * changes when someone remembers to change it.
 */
const VERSION = (process.env.BERRY_VERSION ?? '').trim() || '0.1.0-dev';

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
import { approvalMounts } from './mounts/approvals.ts';
import { inboxMounts } from './mounts/inbox.ts';
import { workspaceReadMounts } from './mounts/workspace-reads.ts';
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
import { ConversationResponder } from './conversations/responder.ts';
import { InboxRepository } from './inbox/repository.ts';
import { ApprovalRepository } from './approvals/repository.ts';
import { OAuthStateStore } from './integrations/oauth.ts';
import { RunRepository } from './runs/repository.ts';
import { RunLedger } from './runs/ledger.ts';
import { Dispatcher } from './runs/dispatcher.ts';
import { agentMounts } from './mounts/agents.ts';
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
import { sealerFromKey } from './integrations/sealing.ts';

/**
 * The composition root.
 *
 * Domain modules contribute mounts and this file is the only place that knows
 * about all of them, which is why no module imports every handler.
 */

const config = loadConfig();
const logger = createLogger(config.serviceName);
const sql = openDatabase({ url: config.databaseUrl });

const sessions = new SessionService({
   sql,
   sessionTtlMs: config.sessionTtlMs,
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

// The App's own credentials are sealed with the same key, for the same reason:
// a deployment that cannot seal cannot hold a private key either.
const githubApp = config.integrationKey
   ? new GitHubAppRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

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
const scmInbound = new ScmInbound({ sql, links: scm.links, logger });

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
 * Token usage the runtime reports on `task.usage`.
 *
 * Interim: workstream C's `recordTaskUsage` (server-ts/src/usage/record.ts)
 * replaces this at merge. Until then usage is logged, not stored, so it is
 * visible rather than silently dropped.
 */
const recordUsage: UsageRecorder = async (_sql, usage) => {
   logger.info('task usage', { ...usage });
};

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
              config.integrations.publicUrl ?? `http://${config.apiAddr.host}:${config.apiAddr.port}`,
           defaultModel: config.runtime.defaultModel,
           memory: runMemory ?? nullRunMemory(),
           sealer: config.integrationKey ? sealerFromKey(config.integrationKey) : null,
           ...(scm.provisioning ? { gitCredential: scm.gitCredential } : {}),
           github: (token) => new GitHubClient({ token }),
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
const commentOptions = { sessions, comments, issues, idempotency, broadcaster };
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
      nested: issueCommentRoutes(commentOptions),
      relations: issueRelationRoutes({ issues, dependencies, reviews, gate: reviewGate }),
      runs: issueRunRoutes(runOptions),
      // A task handed to an agent starts on its own. Only where runs can
      // execute: without an executor a queued run would sit forever.
      ...(executor ? { dispatch: runOptions.runs } : {}),
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
   webhookMounts({
      inbound: scmInbound,
      deliveries: new WebhookDeliveries(sql),
      secret: config.git?.webhookSecret ?? null,
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
registry.registerAll(agentToolMounts({ sql, storage, issues }));
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
registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
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
registry.registerAll(
   conversationMounts({
      sessions,
      conversations: new ConversationRepository(sql),
      boards,
      sql,
      // Reading a thread works without a model credential; only answering
      // needs one, and a null responder says so rather than failing the turn.
      responder:
         executor
         ? new ConversationResponder({
              sql,
              completion,
              defaultModel: config.runtime.defaultModel,
           })
         : null,
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
      publicUrl: config.integrations.publicUrl,
      appUrl: config.integrations.appUrl,
   })
);
registry.registerAll(agentMounts({ sessions, agents, idempotency, catalog: modelCatalog, logger }));
registry.registerAll(
   eventMounts({ sessions, replay: new ReplayRepository(sql), boards, broadcaster })
);
registry.registerAll(
   authMounts({
      sessions,
      identity,
      sql,
      login: {
         allowKnownEmail: config.allowPasswordlessLogin,
         environment: config.appEnv,
      },
   })
);
registry.registerAll(
   platformMounts({
      database: () => checkDatabase(sql),
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
   mounts: registry.prefixes,
});

// Drain on SIGTERM before closing the pool, so a request in flight finishes
// rather than failing at the socket.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.once(signal, () => {
      logger.info('shutting down', { signal });
      server.close(() => {
         // The dispatcher first: it aborts what it is running, and a run left
         // mid-flight is reclaimed from its lease rather than recorded from a
         // process that is on its way out.
         void (dispatcher ? dispatcher.stop() : Promise.resolve())
            .then(() => closeDatabase(sql))
            .then(() => process.exit(0));
      });
   });
}

