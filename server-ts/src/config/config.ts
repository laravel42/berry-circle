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
    * Where an agent's commands run. Null when no substrate is configured, in
    * which case the composition root installs a driver that refuses every
    * call rather than a null every caller has to remember to check.
    */
   execution: ExecutionConfig | null;
   agentCore: AgentCoreConfig | null;
   agentCoreGateway: AgentCoreGatewayConfig | null;
   /** Which GitHub path is live. `agentcore` routes API calls through the gateway. */
   githubProvider: 'agentcore' | 'legacy';
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
   /**
    * Berry's own git server, when the deployment runs one.
    *
    * All three or none: a repositories directory with no key is a repository
    * nothing can reach, and reporting the server as present would promise a
    * checkout that cannot happen.
    */
   git: GitConfig | null;
}

export interface GitConfig {
   /**
    * Shared secret GitHub signs its webhooks with.
    *
    * Null disables the inbound route entirely. An unsigned webhook endpoint is
    * an open door onto every task in the deployment, so "no secret" means "no
    * endpoint" rather than "no checking".
    */
   webhookSecret: string | null;
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
    * Where an agent's commands run.
    *
    * `docker` is the runtime service (`server-ts/src/runtime/`), a disposable
    * container per run on the operator's own Docker daemon — the self-hosted
    * default. `agentcore` is an AWS Bedrock AgentCore Code Interpreter session.
    * `agentcore-runtime` is a deployed AgentCore Runtime, invoked by ARN. Only
    * `docker` uses `baseUrl`/`token`; the AgentCore substrates are reached with
    * SigV4 and addressed from `AgentCoreConfig`.
    */
   driver: 'docker' | 'agentcore' | 'agentcore-runtime';
   baseUrl: string;
   token: string;
}

/**
 * Amazon Bedrock AgentCore, when the deployment uses it.
 *
 * Separate from `AgentConfig` because these are different decisions: Bedrock
 * is where a model is called, AgentCore is where an agent's *work* happens.
 * A deployment can want the first without the second, and most will.
 */
/**
 * AgentCore Gateway and Identity, when GitHub is reached through them.
 *
 * Separate from `AgentCoreConfig` because they answer different questions:
 * that one is where an agent's *work* runs, this is where Berry's external
 * *tool access and credentials* come from. A deployment can want either alone.
 */
export interface AgentCoreGatewayConfig {
   region: string;
   /** The gateway's MCP endpoint. */
   gatewayUrl: string;
   /** The OAuth2 credential provider AgentCore holds GitHub's credential in. */
   githubProviderName: string;
   /** Berry's own registered workload identity. */
   workloadName: string;
   /**
    * Explicit capability-to-tool names, when a gateway's naming defeats
    * matching. Empty is the normal case: names come from discovery.
    */
   toolOverrides: Record<string, string>;
}

export interface AgentCoreConfig {
   region: string;
   /**
    * The Code Interpreter to run an agent's commands in.
    *
    * `aws.codeinterpreter.v1` is the managed one every account has. A custom
    * identifier is a sandbox an operator built with their own network rules —
    * which is what a run needs to clone from GitHub.
    */
   codeInterpreterId: string;
   /** An AgentCore Runtime to invoke instead of executing in this process. */
   runtimeArn: string | null;
   /**
    * An AgentCore Memory store holding what earlier runs did.
    *
    * Null disables recall rather than degrading it: an agent told nothing is
    * an agent that starts fresh, which is the behaviour Berry had before.
    */
   memoryId: string | null;
   /**
    * Explicit credentials for the AgentCore APIs.
    *
    * Required for the same reason Bedrock's are, and it is not a theoretical
    * concern: `AWS_ACCESS_KEY_ID` in the Compose stack holds MinIO's
    * `berryminio`, so a client left on the default chain authenticates to AWS
    * as the object store and is refused. Falls back to the Bedrock pair, which
    * is already the account's real credential.
    */
   credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
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
   /**
    * The AWS region Bedrock is called in.
    *
    * There is no API key beside it. Bedrock authenticates with SigV4 through
    * the AWS credential chain — environment, profile, or the instance's own
    * role — so a deployment on EC2, ECS or Lambda holds no long-lived secret
    * at all, which is the security difference from an API-key provider.
    */
   region: string;
   /**
    * Explicit Bedrock credentials, when the deployment supplies them.
    *
    * Null means the AWS default chain — a role on EC2, ECS or Lambda, or a
    * profile locally. They are *not* read from `AWS_ACCESS_KEY_ID`, because
    * that variable already belongs to Berry's object storage: MinIO is
    * S3-compatible and its `minioadmin` credentials live there. Sharing the
    * name would send MinIO's credentials to AWS and AWS's to MinIO.
    */
   credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null;
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
   /**
    * A ceiling on one model reply, in tokens. Null means the runtime's
    * default (32000). Lowered for a model that accepts less.
    */
   maxTokens: number | null;
   /** How many times AutoGate sends a task back before leaving it to a person. */
   autoGateMaxAttempts: number;
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
      execution: executionConfig,
      agentCore: agentCore(env),
      agentCoreGateway: agentCoreGateway(env),
      githubProvider: (env.GITHUB_PROVIDER ?? 'agentcore').trim() === 'legacy' ? 'legacy' : 'agentcore',
      // No generated fallback: a key that appeared on its own would differ
      // between restarts and strand every credential already stored.
      integrationKey: (env.INTEGRATION_ENCRYPTION_KEY ?? '').trim() || null,
      integrations: integrations(env),
      git: git(env),
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

   if (driver !== 'docker' && driver !== 'agentcore' && driver !== 'agentcore-runtime') {
      problems.push(
         `BERRY_RUNTIME_DRIVER must be 'docker', 'agentcore' or 'agentcore-runtime' when execution is configured, got '${driver}'`
      );
      return null;
   }

   // The AgentCore substrates are reached with SigV4 and addressed from
   // AgentCoreConfig (an interpreter id or a runtime ARN), so they have neither
   // a URL nor a token of their own. Demanding them would make the substrates
   // that need no secret the only ones that cannot start.
   if (driver === 'agentcore' || driver === 'agentcore-runtime') {
      return { driver, baseUrl: '', token: '' };
   }

   if (!baseUrl) problems.push('BERRY_RUNTIME_URL is required when BERRY_RUNTIME_DRIVER=docker');
   if (!token) problems.push('BERRY_RUNTIME_TOKEN is required when BERRY_RUNTIME_DRIVER=docker');
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
 * Where models are called.
 *
 * A region rather than a credential: Bedrock is reached with SigV4 through the
 * AWS credential chain, so what a deployment configures is *where*, not *who*.
 * A region with no usable credentials fails at the first call with an AWS
 * error that names the problem, which is a better failure than this file
 * inventing its own check for a chain it does not own.
 */
function agents(env: NodeJS.ProcessEnv): AgentConfig | null {
   const region = (env.BERRY_BEDROCK_REGION ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? '').trim();
   if (!region) return null;
   const accessKeyId = (env.BERRY_BEDROCK_ACCESS_KEY_ID ?? '').trim();
   const secretAccessKey = (env.BERRY_BEDROCK_SECRET_ACCESS_KEY ?? '').trim();
   const sessionToken = (env.BERRY_BEDROCK_SESSION_TOKEN ?? '').trim();
   return {
      region,
      credentials:
         accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
            : null,
      // An inference profile id, not a bare model id. Anthropic models on
      // Bedrock are only invocable through a cross-region profile in most
      // regions, and the `us.` prefix is what makes the difference between a
      // call that works and a ValidationException that reads like a typo.
      //
      // Haiku 4.5 rather than Sonnet: a third of Sonnet's price ($1/$5 per
      // million against $3/$15) and still reliable at the tool-calling loop a
      // run is. This is the fallback for an agent that names no model, so it is
      // the one paid most often by deployments that never touch the picker.
      defaultModel: (
         env.BERRY_AGENT_DEFAULT_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0'
      ).trim(),
      concurrency: positive(env.BERRY_RUN_CONCURRENCY, 2),
      maxRepairs: positive(env.PLANNER_MAX_REPAIRS, 2),
      maxCriticRounds: positive(env.PLANNER_MAX_CRITIC_ROUNDS, 1),
      maxTokens: env.BERRY_AGENT_MAX_TOKENS ? positive(env.BERRY_AGENT_MAX_TOKENS, 32_000) : null,
      autoGateMaxAttempts: positive(env.BERRY_AUTOGATE_MAX_ATTEMPTS, 2),
   };
}

/**
 * AgentCore's own settings.
 *
 * Null unless a region and an interpreter are both named: an AgentCore driver
 * with half its settings is a substrate that fails at the first command, and
 * the factory says so by name rather than discovering it at run time.
 */
function agentCore(env: NodeJS.ProcessEnv): AgentCoreConfig | null {
   const region = (
      env.BERRY_AGENTCORE_REGION ??
      env.BERRY_BEDROCK_REGION ??
      env.AWS_REGION ??
      ''
   ).trim();
   const codeInterpreterId = (
      env.BERRY_AGENTCORE_CODE_INTERPRETER_ID ?? 'aws.codeinterpreter.v1'
   ).trim();
   if (!region || !codeInterpreterId) return null;
   // AgentCore's own pair first, then Bedrock's: both address AWS proper in the
   // same account, so a deployment that already named one credential should not
   // have to name it twice. Never `AWS_ACCESS_KEY_ID` — that is MinIO's.
   // `||`, not `??`: Compose passes an unset variable as an empty string, and
   // an empty AgentCore key must fall through to Bedrock's rather than count
   // as "configured" and send the clients to the default chain — which in the
   // Compose stack is MinIO's key, refused as an invalid security token.
   const accessKeyId = (
      env.BERRY_AGENTCORE_ACCESS_KEY_ID?.trim() ||
      env.BERRY_BEDROCK_ACCESS_KEY_ID?.trim() ||
      ''
   ).trim();
   const secretAccessKey = (
      env.BERRY_AGENTCORE_SECRET_ACCESS_KEY?.trim() ||
      env.BERRY_BEDROCK_SECRET_ACCESS_KEY?.trim() ||
      ''
   ).trim();
   const sessionToken = (
      env.BERRY_AGENTCORE_SESSION_TOKEN?.trim() ||
      env.BERRY_BEDROCK_SESSION_TOKEN?.trim() ||
      ''
   ).trim();
   return {
      region,
      codeInterpreterId,
      runtimeArn: (env.BERRY_AGENTCORE_RUNTIME_ARN ?? '').trim() || null,
      memoryId: (env.BERRY_AGENTCORE_MEMORY_ID ?? '').trim() || null,
      credentials:
         accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }
            : null,
   };
}

/**
 * The gateway, when one is configured.
 *
 * A URL and a credential provider are both required: a gateway with no
 * identity behind it cannot authorise a call, and reporting it as configured
 * would promise something that fails at the first tool.
 */
function agentCoreGateway(env: NodeJS.ProcessEnv): AgentCoreGatewayConfig | null {
   const gatewayUrl = (env.AWS_AGENTCORE_GATEWAY_URL ?? '').trim();
   const githubProviderName = (env.AWS_AGENTCORE_GITHUB_PROVIDER ?? '').trim();
   if (!gatewayUrl || !githubProviderName) return null;

   let toolOverrides: Record<string, string> = {};
   const raw = (env.BERRY_AGENTCORE_TOOL_MAP ?? '').trim();
   if (raw) {
      try {
         const parsed: unknown = JSON.parse(raw);
         if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            toolOverrides = Object.fromEntries(
               Object.entries(parsed as Record<string, unknown>)
                  .filter(([, value]) => typeof value === 'string')
                  .map(([key, value]) => [key, value as string])
            );
         }
      } catch {
         // Left empty rather than fatal: a malformed override should cost the
         // override, not the deployment. Discovery still resolves the rest.
      }
   }

   return {
      region: (env.AWS_AGENTCORE_REGION ?? env.AWS_REGION ?? 'us-east-1').trim(),
      gatewayUrl,
      githubProviderName,
      workloadName: (env.AWS_AGENTCORE_WORKLOAD_NAME ?? 'berry').trim(),
      toolOverrides,
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

/**
 * How GitHub reaches Berry.
 *
 * There is no host or credential here any more: repositories are GitHub's, and
 * the credential is a GitHub App installation token minted per run by
 * `GitHubAppRepository`. What remains is the one secret that is Berry's own —
 * the webhook signing key.
 */
function git(env: NodeJS.ProcessEnv): GitConfig | null {
   const webhookSecret = (env.BERRY_GITHUB_WEBHOOK_SECRET ?? '').trim();
   return webhookSecret ? { webhookSecret } : null;
}

