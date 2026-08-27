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
import { projectMounts } from './mounts/projects.ts';
import { internalRunMounts } from './mounts/internal-runs.ts';
import { agentMounts } from './mounts/agents.ts';
import { IdentityRepository } from './identity/repository.ts';
import { WorkspaceRepository } from './identity/workspaces.ts';
import { SecretsRepository } from './identity/secrets.ts';
import { BoardRepository } from './core/boards.ts';
import { IssueRepository } from './core/issues.ts';
import { CommentRepository } from './core/comments.ts';
import { ProjectRepository } from './core/projects.ts';
import { Hub } from './realtime/hub.ts';
import { Distributed } from './realtime/distributed.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { SessionService } from './auth/sessions.ts';
import { Storage } from './storage/storage.ts';
import { AdkExecutor } from './agents/executor.ts';
import { AgentRepository } from './agents/repository.ts';
import { ModelCatalog } from './agents/catalog.ts';

/**
 * The composition root, the counterpart to server/cmd/api/main.go.
 *
 * Domain modules contribute mounts and this file is the only place that knows
 * about all of them — the same arrangement the Go server uses, and the reason
 * no package there imports every handler.
 */

const config = loadConfig();
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

const executor =
   config.agents && storage
      ? new AdkExecutor({
           sql,
           storage,
           apiKey: config.agents.apiKey,
           baseUrl: config.agents.baseUrl,
           defaultModel: config.agents.defaultModel,
        })
      : null;

// The model picker's catalogue. Null without a credential rather than an
// empty list: "no models exist" and "this server cannot ask" are different
// answers, and only one of them is true.
const modelCatalog = config.agents
   ? new ModelCatalog({ baseUrl: config.agents.baseUrl })
   : null;

const registry = new Registry();
registry.registerAll(meMounts({ sessions, identity }));
registry.registerAll(workspaceMounts({ sessions, workspaces, secrets }));
registry.registerAll(secretsMounts({ sessions, secrets }));
registry.registerAll(boardMounts({ sessions, boards, idempotency }));
const commentOptions = { sessions, comments, issues, idempotency, broadcaster };
registry.registerAll(
   issueMounts({
      sessions,
      issues,
      boards,
      idempotency,
      broadcaster,
      nested: issueCommentRoutes(commentOptions),
   })
);
registry.registerAll(commentMounts(commentOptions));
registry.registerAll(projectMounts({ sessions, projects, idempotency }));
registry.registerAll(internalRunMounts({ executor, token: config.internalToken }));
registry.registerAll(agentMounts({ sessions, agents, idempotency, catalog: modelCatalog }));
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
         realtime: false,
         storage: storage !== null,
         valkey: false,
         planner: false,
         workflows: false,
      },
   })
);

const app = createApp(registry);

const server = serve({ fetch: app.fetch, hostname: config.apiAddr.host, port: config.apiAddr.port });
log('info', 'Berry TypeScript server listening', {
   apiAddr: `${config.apiAddr.host}:${config.apiAddr.port}`,
   environment: config.appEnv,
   mounts: registry.prefixes,
});

// The Go server drains on SIGTERM before closing the pool, so a request in
// flight finishes rather than failing at the socket.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.once(signal, () => {
      log('info', 'shutting down', { signal });
      server.close(() => {
         void closeDatabase(sql).then(() => process.exit(0));
      });
   });
}

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
   // The same JSON line shape the Go server emits, so one log pipeline reads
   // both while the migration is in flight.
   console.log(JSON.stringify({ time: new Date().toISOString(), level: level.toUpperCase(), msg, service: config.serviceName, ...fields }));
}
