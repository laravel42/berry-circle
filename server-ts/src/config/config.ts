/**
 * Environment — the subset this server needs.
 *
 * The variable names are long-standing and deployments are configured with
 * them, so a rename here is a setting that silently stops applying.
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
   /**
    * Where an agent's commands run. Null when no substrate is configured, in
    * which case the composition root installs a driver that refuses every
    * call rather than a null every caller has to remember to check.
    */
   execution: ExecutionConfig | null;
   /**
    * Seals provider credentials at rest. Null leaves integrations off — a
    * deployment without a key stores nothing rather than storing it in clear.
    */
   integrationKey: string | null;
   /**
    * What this deployment can connect to, and where a provider sends the
    * browser back.
    *
    * Null for either half is a working deployment: the catalogue then says a
    * provider is not configured, which is a better answer than a Connect
    * button that leads to a redirect loop.
    */
   integrations: IntegrationsConfig;
}

/**
 * The execution substrate.
 *
 * `driver` exists so a self-hosted deployment can select a local container
 * runtime without this file learning what Cloudflare is — the driver name is
 * the only thing config knows, and the factory maps it to an implementation.
 */
export interface ExecutionConfig {
   /**
    * `docker` is the runtime service in `runtime/`, for a self-hosted Berry.
    * `cloudflare` is the worker in `runtime-worker/`, for the hosted
    * workspace. They speak the same protocol; the name selects a label, not a
    * different client.
    */
   driver: 'docker' | 'cloudflare';
   baseUrl: string;
   token: string;
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

/** OAuth credentials, and the origins a provider redirects between. */
export interface IntegrationsConfig {
   github: { clientId: string; clientSecret: string } | null;
   /**
    * This server's own public origin — where the provider sends the browser
    * back. Not derivable from a request: behind a proxy the request's own
    * host is the proxy's, and a redirect_uri that does not match the one
    * registered with the provider is refused before Berry sees it.
    */
   publicUrl: string | null;
   /** Where the browser lands afterwards. The frontend, when it is separate. */
   appUrl: string | null;
}

/** What agents run on. Null when no model credential is configured. */
export interface AgentConfig {
   apiKey: string;
   baseUrl: string;
   /** Used when an agent row names no model of its own. */
   defaultModel: string;
   /**
    * How many runs this process executes at once.
    *
    * Two by default, and low on purpose: each run holds a container and a
    * model call, so this is a cost ceiling as much as a load one. Raising it
    * on one server and running several servers are both ways to go faster,
    * and the claim is safe either way.
    */
   concurrency: number;
   /**
    * How many times a plan may be sent back to be fixed, and how many times
    * the critic may ask for a revision.
    *
    * Low on purpose: a model that cannot fix its own dependency graph in two
    * attempts will not fix it in ten, and every attempt is paid for.
    */
   maxRepairs: number;
   maxCriticRounds: number;
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

   // The Dockerfile sets this; the default matches it so a bare `node` run agrees.
   const addr = (env.API_ADDR ?? '0.0.0.0:4000').trim();
   const separator = addr.lastIndexOf(':');
   const host = separator > 0 ? addr.slice(0, separator) : '0.0.0.0';
   const port = Number(separator > 0 ? addr.slice(separator + 1) : addr);
   if (!Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`API_ADDR must end in a port, got ${addr}`);
   }

   // Read before the check below, so a misconfigured substrate is reported
   // with everything else rather than collected into a list nobody throws.
   const executionConfig = execution(env, problems);

   if (problems.length > 0) throw new ConfigError(problems);

   return {
      appEnv: (env.APP_ENV ?? 'development').trim(),
      serviceName: (env.SERVICE_NAME ?? 'berry-server').trim(),
      apiAddr: { host, port },
      databaseUrl,
      metricsEnabled: boolean(env.METRICS_ENABLED, true),
      sessionTtlMs: duration(env.SESSION_TTL, 30 * 24 * 60 * 60 * 1000),
      allowPasswordlessLogin: boolean(env.AUTH_ALLOW_PASSWORDLESS_LOGIN, true),
      // Per-subscriber event buffer, before a slow client is dropped.
      realtimeBuffer: positiveInt(env.REALTIME_BUFFER, 64),
      storage: storage(env),
      agents: agents(env),
      // Trimmed and required to be non-empty: a variable set to whitespace is
      // an operator who meant to set it, and treating that as "configured"
      // would accept a token nothing can present.
      internalToken: (env.BERRY_INTERNAL_TOKEN ?? '').trim() || null,
      execution: executionConfig,
      // No generated fallback: a key that appeared on its own would differ
      // between restarts and strand every credential already stored.
      integrationKey: (env.INTEGRATION_ENCRYPTION_KEY ?? '').trim() || null,
      integrations: integrations(env),
   };
}

/**
 * Reads the execution substrate, or nothing.
 *
 * Both halves are required together. A base URL with no token would present
 * no credential and be refused on every call, and a token with no URL has
 * nothing to authenticate to — either alone is a misconfiguration worth
 * reporting at boot rather than at the first run.
 */
function execution(env: NodeJS.ProcessEnv, problems: string[]): ExecutionConfig | null {
   const driver = (env.BERRY_RUNTIME_DRIVER ?? '').trim();
   const baseUrl = (env.BERRY_RUNTIME_URL ?? '').trim();
   const token = (env.BERRY_RUNTIME_TOKEN ?? '').trim();

   if (!driver && !baseUrl && !token) return null;

   if (driver !== 'docker' && driver !== 'cloudflare') {
      problems.push(
         `BERRY_RUNTIME_DRIVER must be 'docker' or 'cloudflare' when execution is configured, got '${driver}'`
      );
      return null;
   }
   if (!baseUrl) problems.push('BERRY_RUNTIME_URL is required when BERRY_RUNTIME_DRIVER is set');
   if (!token) problems.push('BERRY_RUNTIME_TOKEN is required when BERRY_RUNTIME_DRIVER is set');
   if (!baseUrl || !token) return null;

   return { driver, baseUrl, token };
}

/**
 * Object storage, from the standard S3 variables.
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
 * The model credential.
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
      concurrency: positive(env.BERRY_RUN_CONCURRENCY, 2),
      maxRepairs: positive(env.PLANNER_MAX_REPAIRS, 2),
      maxCriticRounds: positive(env.PLANNER_MAX_CRITIC_ROUNDS, 1),
   };
}

function integrations(env: NodeJS.ProcessEnv): IntegrationsConfig {
   const clientId = (env.GITHUB_CLIENT_ID ?? '').trim();
   const clientSecret = (env.GITHUB_CLIENT_SECRET ?? '').trim();
   return {
      // Both or neither: half a credential cannot complete an exchange, and
      // reporting the provider as configured would promise that it can.
      github: clientId && clientSecret ? { clientId, clientSecret } : null,
      publicUrl: origin(env.BERRY_PUBLIC_URL),
      appUrl: origin(env.BERRY_APP_URL),
   };
}

/** A URL with no trailing slash, or null when it is not one. */
function origin(value: string | undefined): string | null {
   const trimmed = (value ?? '').trim();
   if (!trimmed) return null;
   try {
      return new URL(trimmed).origin;
   } catch {
      return null;
   }
}

/** A count, when the value given is one. Anything else keeps the default. */
function positive(value: string | undefined, fallback: number): number {
   const parsed = /^\d+$/.test((value ?? '').trim()) ? Number(value) : Number.NaN;
   return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Duration strings as the compose file writes them: `720h`, `30m`, `1s`.
 *
 * Compound forms like `2h5m` are accepted because a deployment may already
 * have one configured, and rejecting it would turn a working setting into a
 * boot failure.
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

/** A positive integer, or the fallback. */
function positiveInt(value: string | undefined, fallback: number): number {
   const trimmed = (value ?? '').trim();
   if (!trimmed || !/^\d+$/.test(trimmed)) return fallback;
   const parsed = Number(trimmed);
   return parsed > 0 ? parsed : fallback;
}
