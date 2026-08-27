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
   sessionTtlMs: number;
   allowPasswordlessLogin: boolean;
   /** Per-subscriber realtime event buffer, before a slow client is dropped. */
   realtimeBuffer: number;
   storage: StorageConfig | null;
   agents: AgentConfig | null;
   /**
    * The shared secret that lets Berry's own worker ask this server to execute
    * a run. Null disables the internal surface entirely rather than leaving it
    * open — an unauthenticated endpoint that runs agents and spends money is
    * not something to default into.
    */
   internalToken: string | null;
}

/** Object storage for run artifacts. Null when it is not configured. */
export interface StorageConfig {
   bucket: string;
   region: string;
   endpoint: string | undefined;
   forcePathStyle: boolean;
   accessKeyId: string | undefined;
   secretAccessKey: string | undefined;
   sessionToken: string | undefined;
   maxBytes: number;
}

/** What agents run on. Null when no model credential is configured. */
export interface AgentConfig {
   apiKey: string;
   baseUrl: string;
   /** Used when an agent row names no model of its own. */
   defaultModel: string;
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
      sessionTtlMs: duration(env.SESSION_TTL, 30 * 24 * 60 * 60 * 1000),
      allowPasswordlessLogin: boolean(env.AUTH_ALLOW_PASSWORDLESS_LOGIN, true),
      // Per-subscriber event buffer. Reading the same variable Go reads, so a
      // deployment tuned for one server is tuned for both.
      realtimeBuffer: positiveInt(env.REALTIME_BUFFER, 64),
      storage: storage(env),
      agents: agents(env),
      // Trimmed and required to be non-empty: a variable set to whitespace is
      // an operator who meant to set it, and treating that as "configured"
      // would accept a token nothing can present.
      internalToken: (env.BERRY_INTERNAL_TOKEN ?? '').trim() || null,
   };
}

/**
 * Reads the same S3 variables the Go server reads.
 *
 * Only the bucket is required. Credentials may be absent on purpose — the AWS
 * SDK then uses the workload's credential chain, which is how this runs
 * outside development.
 */
function storage(env: NodeJS.ProcessEnv): StorageConfig | null {
   const bucket = (env.S3_BUCKET ?? '').trim();
   if (!bucket) return null;
   return {
      bucket,
      region: (env.S3_REGION ?? 'us-east-1').trim(),
      endpoint: (env.S3_ENDPOINT ?? '').trim() || undefined,
      // MinIO addresses buckets by path, not by subdomain.
      forcePathStyle: boolean(env.S3_USE_PATH_STYLE, true),
      accessKeyId: (env.AWS_ACCESS_KEY_ID ?? '').trim() || undefined,
      secretAccessKey: (env.AWS_SECRET_ACCESS_KEY ?? '').trim() || undefined,
      sessionToken: (env.AWS_SESSION_TOKEN ?? '').trim() || undefined,
      maxBytes: positiveInt(env.STORAGE_MAX_BYTES, 25 * 1024 * 1024),
   };
}

/**
 * The model credential, read from the same variable the gateway reads.
 *
 * BERRY_-prefixed first, for the reason the compose file gives: a stale
 * OPENROUTER_API_KEY exported in a shell would otherwise silently outrank the
 * one the deployment configured.
 */
function agents(env: NodeJS.ProcessEnv): AgentConfig | null {
   const apiKey = (env.BERRY_OPENROUTER_API_KEY ?? env.OPENROUTER_API_KEY ?? '').trim();
   if (!apiKey) return null;
   return {
      apiKey,
      baseUrl: (env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1').trim(),
      defaultModel: (env.BERRY_AGENT_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5').trim(),
   };
}

/**
 * Go duration strings, as the compose file writes them: `720h`, `30m`, `1s`.
 * Compound forms like `2h5m` are accepted here even though Temporal's `ms`
 * parser rejects them, because this reads the same environment Go does.
 */
function duration(value: string | undefined, fallback: number): number {
   const trimmed = (value ?? '').trim();
   if (!trimmed) return fallback;
   const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
   let total = 0;
   let matched = false;
   for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
      total += Number(amount) * (units[unit as string] ?? 0);
      matched = true;
   }
   return matched ? total : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
   const trimmed = (value ?? '').trim().toLowerCase();
   if (trimmed === '') return fallback;
   return trimmed === 'true' || trimmed === '1' || trimmed === 'yes';
}

/** A positive integer, or the fallback. Matches Go's positiveInt. */
function positiveInt(value: string | undefined, fallback: number): number {
   const trimmed = (value ?? '').trim();
   if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
   const parsed = Number(trimmed);
   return parsed > 0 ? parsed : fallback;
}
