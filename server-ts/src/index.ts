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
import { projectMounts } from './mounts/projects.ts';
import { IdentityRepository } from './identity/repository.ts';
import { WorkspaceRepository } from './identity/workspaces.ts';
import { SecretsRepository } from './identity/secrets.ts';
import { BoardRepository } from './core/boards.ts';
import { IssueRepository } from './core/issues.ts';
import { ProjectRepository } from './core/projects.ts';
import { Hub } from './realtime/hub.ts';
import { Distributed } from './realtime/distributed.ts';
import { IdempotencyStore } from './http/idempotency.ts';
import { SessionService } from './auth/sessions.ts';

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
const projects = new ProjectRepository(sql);

// A hub with no relay for now: this process delivers to its own subscribers.
// The Valkey relay is wired when the SSE endpoints land, so a subscriber
// exists to receive what other nodes publish.
const broadcaster = new Distributed(new Hub(config.realtimeBuffer), null);
const idempotency = new IdempotencyStore(sql);

const registry = new Registry();
registry.registerAll(meMounts({ sessions, identity }));
registry.registerAll(workspaceMounts({ sessions, workspaces, secrets }));
registry.registerAll(secretsMounts({ sessions, secrets }));
registry.registerAll(boardMounts({ sessions, boards, idempotency }));
registry.registerAll(issueMounts({ sessions, issues, boards, idempotency, broadcaster }));
registry.registerAll(projectMounts({ sessions, projects, idempotency }));
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
         agentExecution: false,
         // False regardless of configuration: this process does not serve
         // /metrics yet, and a capability the browser is told about must be
         // one the server actually has.
         metrics: false,
         realtime: false,
         storage: false,
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
