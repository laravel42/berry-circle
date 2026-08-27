/**
 * Environment, ported from server/internal/config/config.go — the subset this
 * server needs so far.
 *
 * Same variable names as the Go server on purpose: both read the same
 * docker-compose environment during the migration, so a name that drifts is a
 * setting that silently stops applying to one of them.
 */

export interface Config {
   appEnv: string;
   serviceName: string;
   apiAddr: { host: string; port: number };
   databaseUrl: string;
   metricsEnabled: boolean;
}

export class ConfigError extends Error {
   constructor(problems: string[]) {
      super(`configuration is invalid:\n  - ${problems.join('\n  - ')}`);
      this.name = 'ConfigError';
   }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
   const problems: string[] = [];

   const databaseUrl = (env.DATABASE_URL ?? '').trim();
   if (!databaseUrl) problems.push('DATABASE_URL is required');

   // Go's default is 0.0.0.0:4000, set in the Dockerfile.
   const addr = (env.API_ADDR ?? '0.0.0.0:4000').trim();
   const separator = addr.lastIndexOf(':');
   const host = separator > 0 ? addr.slice(0, separator) : '0.0.0.0';
   const port = Number(separator > 0 ? addr.slice(separator + 1) : addr);
   if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`API_ADDR must end in a port, got ${addr}`);
   }

   if (problems.length > 0) throw new ConfigError(problems);

   return {
      appEnv: (env.APP_ENV ?? 'development').trim(),
      serviceName: (env.SERVICE_NAME ?? 'berry-server').trim(),
      apiAddr: { host, port },
      databaseUrl,
      metricsEnabled: boolean(env.METRICS_ENABLED, true),
   };
}

function boolean(value: string | undefined, fallback: boolean): boolean {
   const trimmed = (value ?? '').trim().toLowerCase();
   if (trimmed === '') return fallback;
   return trimmed === 'true' || trimmed === '1' || trimmed === 'yes';
}
