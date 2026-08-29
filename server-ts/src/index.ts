import { serve } from '@hono/node-server';
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
import { goalMounts } from './mounts/goals.ts';
import { attachmentMounts } from './mounts/attachments.ts';
import { projectMounts } from './mounts/projects.ts';
import { internalRunMounts } from './mounts/internal-runs.ts';
import { boardRunRoutes, issueRunRoutes, runMounts } from './mounts/runs.ts';
import { integrationMounts } from './mounts/integrations.ts';
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
import { AttachmentRepository } from './core/attachments.ts';
import { ProjectRepository } from './core/projects.ts';
import { Hub } from './realtime/hub.ts';
import { Distributed } from './realtime/distributed.ts';
import { ReplayRepository } from './realtime/replay.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { SessionService } from './auth/sessions.ts';
import { Storage } from './storage/storage.ts';
import { AdkExecutor } from './agents/executor.ts';
import { AgentRepository } from './agents/repository.ts';
import { ModelCatalog } from './agents/catalog.ts';
import { createLogger } from './observability/log.ts';
import { createExecutionDriver } from './execution/factory.ts';
import { ConnectionRepository } from './integrations/connections.ts';
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
 * The agent runtime, present only when this server can actually run one.
 *
 * Both halves are required and neither has a safe default: without a model
 * credential there is nothing to call, and without object storage an agent's
 * files would have nowhere to land — a run that produced work and dropped it
 * is worse than one that never started.
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
 * Where an agent's commands run.
 *
 * Constructed even when nothing is configured — the unconfigured driver
 * refuses every call with a message naming what is missing, which is a better
 * failure than a null that reaches a call site expecting a driver.
 */
const execution = createExecutionDriver(config.execution);

/**
 * Provider connections, when a key exists to open them with.
 *
 * Null rather than a repository that cannot decrypt: a run then simply never
 * gets a repository, which is a working deployment, instead of one that fails
 * at the clone with a decryption error.
 */
const connections = config.integrationKey
   ? new ConnectionRepository({ sql, sealer: sealerFromKey(config.integrationKey) })
   : null;

const executor =
   config.agents && storage
      ? new AdkExecutor({
           sql,
           storage,
           apiKey: config.agents.apiKey,
           baseUrl: config.agents.baseUrl,
           defaultModel: config.agents.defaultModel,
           // Only when one is actually configured. Handing over the
           // unconfigured driver would give agents a `run_command` that
           // refuses every call, and an agent cannot work around a tool it was
           // told it has.
           ...(config.execution ? { execution } : {}),
           ...(connections ? { connections } : {}),
        })
      : null;

// The model picker's catalogue. Null without a credential rather than an
// empty list: "no models exist" and "this server cannot ask" are different
// answers, and only one of them is true.
const modelCatalog = config.agents
   ? new ModelCatalog({ baseUrl: config.agents.baseUrl })
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
registry.registerAll(meMounts({ sessions, identity }));
registry.registerAll(workspaceMounts({ sessions, workspaces, secrets }));
registry.registerAll(secretsMounts({ sessions, secrets }));
registry.registerAll(
   boardMounts({ sessions, boards, idempotency, nested: boardRunRoutes(runOptions) })
);
const commentOptions = { sessions, comments, issues, idempotency, broadcaster };
registry.registerAll(
   issueMounts({
      sessions,
      issues,
      boards,
      idempotency,
      broadcaster,
      nested: issueCommentRoutes(commentOptions),
      relations: issueRelationRoutes({ issues, dependencies, reviews }),
      runs: issueRunRoutes(runOptions),
   })
);
registry.registerAll(commentMounts(commentOptions));
registry.registerAll(goalMounts({ sessions, goals, issues, idempotency, broadcaster }));
registry.registerAll(attachmentMounts({ sessions, attachments, storage }));
registry.registerAll(projectMounts({ sessions, projects, idempotency }));
registry.registerAll(internalRunMounts({ executor, token: config.internalToken }));
registry.registerAll(runMounts(runOptions));
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
      publicUrl: config.integrations.publicUrl,
      appUrl: config.integrations.appUrl,
   })
);
registry.registerAll(agentMounts({ sessions, agents, idempotency, catalog: modelCatalog }));
registry.registerAll(
   eventMounts({ sessions, replay: new ReplayRepository(sql), boards, broadcaster })
);
registry.registerAll(
   authMounts({
      sessions,
      login: {
         allowKnownEmail: config.allowPasswordlessLogin,
         environment: config.appEnv,
      },
   })
);
registry.registerAll(
   platformMounts({
      database: () => checkDatabase(sql),
      capabilities: {
         // Reported by whichever server answers, so they have to agree. Only
         // what this process can actually do is true; the rest arrive with the
         // mounts that provide them.
         // True only when a model credential and object storage are both
         // present: this is what the browser uses to decide whether running
         // an agent is offered at all.
         agentExecution: executor !== null && config.internalToken !== null,
         // False regardless of configuration: this process does not serve
         // /metrics yet, and a capability the browser is told about must be
         // one the server actually has.
         metrics: false,
         // The event streams are served here now. The relay is not wired, so
         // a fact published by another process arrives on the next poll
         // rather than instantly — later, never lost, because the stream
         // replays from PostgreSQL and Valkey only ever wakes it.
         realtime: true,
         storage: storage !== null,
         valkey: false,
         planner: false,
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
const dispatcher =
   executor && config.agents
      ? new Dispatcher({
           sql,
           executor,
           logger,
           concurrency: config.agents.concurrency,
        })
      : null;
dispatcher?.start();

const app = createApp(registry);

const server = serve({ fetch: app.fetch, hostname: config.apiAddr.host, port: config.apiAddr.port });
logger.info('Berry server listening', {
   apiAddr: `${config.apiAddr.host}:${config.apiAddr.port}`,
   environment: config.appEnv,
   // Named at boot so an operator can see which substrate this process would
   // run an agent's commands on, without reading the environment back.
   executionDriver: execution.name,
   // Named at boot because a server that admits runs but does not execute them
   // looks identical from outside until the first one sits queued forever.
   runDispatch: dispatcher ? `${config.agents!.concurrency} at a time` : 'off',
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

