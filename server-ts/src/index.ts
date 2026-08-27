import { serve } from '@hono/node-server';
import { loadConfig } from './config/config.ts';
import { checkDatabase, closeDatabase, openDatabase } from './db/pool.ts';
import { createApp } from './http/app.ts';
import { Registry } from './http/registry.ts';
import { platformMounts } from './mounts/platform.ts';

/**
 * The composition root, the counterpart to server/cmd/api/main.go.
 *
 * Domain modules contribute mounts and this file is the only place that knows
 * about all of them — the same arrangement the Go server uses, and the reason
 * no package there imports every handler.
 */

const config = loadConfig();
const sql = openDatabase({ url: config.databaseUrl });

const registry = new Registry();
registry.registerAll(
   platformMounts({
      database: () => checkDatabase(sql),
      capabilities: {
         // Reported by whichever server answers, so they have to agree. Only
         // what this process can actually do is true; the rest arrive with the
         // mounts that provide them.
         agentExecution: false,
         metrics: config.metricsEnabled,
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
