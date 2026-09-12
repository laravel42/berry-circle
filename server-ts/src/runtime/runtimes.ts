import type { Sql } from '../db/pool.ts';
import type { Sealer } from '../integrations/sealing.ts';
import type { RuntimeTarget } from './transport.ts';

/**
 * A workspace's runtimes and their profiles (ADR-0014): where its agents run,
 * and with what environment. Every read and write names the workspace, so a
 * row from another workspace is indistinguishable from one that is not there.
 */

export interface RuntimeView {
   id: string;
   name: string;
   kind: 'platform' | 'custom';
   driver: 'agentcore' | 'http';
   arn: string | null;
   endpointUrl: string | null;
   qualifier: string;
   region: string | null;
   status: 'active' | 'unreachable' | 'disabled';
   lastHealthAt: string | null;
   lastHealthError: string | null;
   concurrencyLimit: number | null;
   visibility: 'private' | 'workspace';
   /** Who registered it. Only they may change whether the workspace sees it. */
   ownerId: string | null;
   idleTimeoutS: number;
   maxLifetimeS: number;
   isDefault: boolean;
   activeRuns: number;
}

/** Env values are sealed at rest and never leave the server; only their names do. */
export interface ProfileView {
   id: string;
   runtimeId: string;
   name: string;
   envKeys: string[];
   modelDefault: string | null;
   timeoutS: number | null;
   maxConcurrency: number | null;
   idleTimeoutS: number | null;
}

export interface RuntimeInput {
   name?: string | undefined;
   driver?: 'agentcore' | 'http' | undefined;
   arn?: string | null | undefined;
   endpointUrl?: string | null | undefined;
   qualifier?: string | undefined;
   region?: string | null | undefined;
   concurrencyLimit?: number | null | undefined;
   visibility?: 'private' | 'workspace' | undefined;
   idleTimeoutS?: number | undefined;
   isDefault?: boolean | undefined;
   status?: 'active' | 'disabled' | undefined;
}

export interface ProfileInput {
   name?: string | undefined;
   env?: Record<string, string> | undefined;
   modelDefault?: string | null | undefined;
   timeoutS?: number | null | undefined;
   maxConcurrency?: number | null | undefined;
   idleTimeoutS?: number | null | undefined;
}

/** An agent bound to a runtime, as the detail page and the delete confirm name it. */
export interface ServingAgent {
   id: string;
   name: string;
   status: string;
   profileName: string | null;
}

/** Every agent of a workspace and the runtime it is bound to, if any. */
export interface AgentCoverage {
   /** The workspace's default runtime, which an unbound agent falls back to. */
   defaultRuntimeId: string | null;
   nodes: Array<{ id: string; name: string; runtimeId: string | null; runtimeName: string | null }>;
}

export class RuntimeNotFound extends Error {}
export class RuntimeProtected extends Error {}
/** Profile env was sent to a deployment that has no key to seal it with. */
export class RuntimeSealingUnavailable extends Error {}

const COLUMNS = `r.id, r.name, r.kind, r.driver, r.arn, r.endpoint_url, r.qualifier, r.region, r.status,
   r.last_health_at, r.last_health_error, r.concurrency_limit, r.visibility, r.owner_id, r.idle_timeout_s,
   r.max_lifetime_s, r.is_default,
   (SELECT count(*) FROM runs AS x WHERE x.runtime_id = r.id AND x.status IN ('queued', 'running'))::int AS active_runs`;

function toView(row: Record<string, unknown>): RuntimeView {
   return {
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as RuntimeView['kind'],
      driver: row.driver as RuntimeView['driver'],
      arn: (row.arn as string | null) ?? null,
      endpointUrl: (row.endpoint_url as string | null) ?? null,
      qualifier: row.qualifier as string,
      region: (row.region as string | null) ?? null,
      status: row.status as RuntimeView['status'],
      lastHealthAt: row.last_health_at ? new Date(row.last_health_at as string).toISOString() : null,
      lastHealthError: (row.last_health_error as string | null) ?? null,
      concurrencyLimit: (row.concurrency_limit as number | null) ?? null,
      visibility: row.visibility as RuntimeView['visibility'],
      ownerId: (row.owner_id as string | null) ?? null,
      idleTimeoutS: Number(row.idle_timeout_s),
      maxLifetimeS: Number(row.max_lifetime_s),
      isDefault: Boolean(row.is_default),
      activeRuns: Number(row.active_runs),
   };
}

function toProfile(row: Record<string, unknown>): ProfileView {
   return {
      id: row.id as string,
      runtimeId: row.runtime_id as string,
      name: row.name as string,
      envKeys: (row.env_keys as string[] | null) ?? [],
      modelDefault: (row.model_default as string | null) ?? null,
      timeoutS: (row.timeout_s as number | null) ?? null,
      maxConcurrency: (row.max_concurrency as number | null) ?? null,
      idleTimeoutS: (row.idle_timeout_s as number | null) ?? null,
   };
}

export class RuntimeRepository {
   readonly #sql: Sql;
   readonly #sealer: Sealer | null;

   constructor(sql: Sql, sealer: Sealer | null) {
      this.#sql = sql;
      this.#sealer = sealer;
   }

   async list(workspaceId: string, viewerId: string): Promise<RuntimeView[]> {
      const rows = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM agent_runtimes AS r
          WHERE r.workspace_id = ${workspaceId}
            AND (r.visibility = 'workspace' OR r.owner_id = ${viewerId})
          ORDER BY r.kind DESC, r.created_at ASC`;
      return rows.map(toView);
   }

   async get(workspaceId: string, id: string): Promise<RuntimeView> {
      const [row] = await this.#sql`
         SELECT ${this.#sql.unsafe(COLUMNS)} FROM agent_runtimes AS r
          WHERE r.id = ${id} AND r.workspace_id = ${workspaceId}`;
      if (!row) throw new RuntimeNotFound();
      return toView(row);
   }

   async activity(workspaceId: string, id: string): Promise<Array<{ day: string; runs: number; failed: number }>> {
      const rows = await this.#sql`
         SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                count(*)::int AS runs, count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM runs
          WHERE workspace_id = ${workspaceId} AND runtime_id = ${id}
            AND created_at > now() - interval '30 days'
          GROUP BY 1 ORDER BY 1`;
      return rows.map((row) => ({ day: row.day as string, runs: Number(row.runs), failed: Number(row.failed) }));
   }

   /**
    * The agents this runtime serves. What a delete is really asking about, and
    * what the detail page names before it asks.
    */
   async servingAgents(workspaceId: string, id: string): Promise<ServingAgent[]> {
      const rows = await this.#sql`
         SELECT a.id, a.name, a.status,
                (SELECT p.name FROM runtime_profiles p WHERE p.id = a.runtime_profile_id) AS profile_name
           FROM agents AS a
          WHERE a.workspace_id = ${workspaceId} AND a.runtime_id = ${id} AND a.archived_at IS NULL
          ORDER BY lower(a.name), a.id`;
      return rows.map((row) => ({
         id: row.id as string,
         name: row.name as string,
         status: (row.status as string | null) ?? 'unknown',
         profileName: (row.profile_name as string | null) ?? null,
      }));
   }

   /**
    * Which agents have somewhere to run. An agent bound to no runtime still
    * runs when the workspace has a default, so the default is named rather
    * than folded in: the caller decides what "has a runtime" means to it.
    */
   async agentCoverage(workspaceId: string): Promise<AgentCoverage> {
      const [defaultRow] = await this.#sql`
         SELECT id FROM agent_runtimes WHERE workspace_id = ${workspaceId} AND is_default LIMIT 1`;
      const rows = await this.#sql`
         SELECT a.id, a.name, a.runtime_id,
                (SELECT r.name FROM agent_runtimes r WHERE r.id = a.runtime_id) AS runtime_name
           FROM agents AS a
          WHERE a.workspace_id = ${workspaceId} AND a.archived_at IS NULL
          ORDER BY lower(a.name), a.id`;
      return {
         defaultRuntimeId: (defaultRow?.id as string | undefined) ?? null,
         nodes: rows.map((row) => ({
            id: row.id as string,
            name: row.name as string,
            runtimeId: (row.runtime_id as string | null) ?? null,
            runtimeName: (row.runtime_name as string | null) ?? null,
         })),
      };
   }

   async create(workspaceId: string, ownerId: string, input: RuntimeInput): Promise<RuntimeView> {
      const [row] = await this.#sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, arn, endpoint_url, qualifier, region,
                                     concurrency_limit, visibility, owner_id, idle_timeout_s)
         VALUES (${workspaceId}, ${input.name ?? 'Runtime'}, 'custom', ${input.driver ?? 'agentcore'},
                 ${input.arn ?? null}, ${input.endpointUrl ?? null}, ${input.qualifier ?? 'DEFAULT'},
                 ${input.region ?? null}, ${input.concurrencyLimit ?? null}, ${input.visibility ?? 'workspace'},
                 ${ownerId}, ${input.idleTimeoutS ?? 3600})
         RETURNING id`;
      return this.get(workspaceId, row!.id as string);
   }

   async update(workspaceId: string, id: string, input: RuntimeInput): Promise<RuntimeView> {
      await this.get(workspaceId, id);
      await this.#sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         // One default per workspace (a partial unique index): clear first.
         if (input.isDefault) {
            await tx`UPDATE agent_runtimes SET is_default = false WHERE workspace_id = ${workspaceId} AND id <> ${id}`;
         }
         await tx`
            UPDATE agent_runtimes SET
               name = COALESCE(${input.name ?? null}, name),
               arn = CASE WHEN ${input.arn !== undefined}::boolean THEN ${input.arn ?? null} ELSE arn END,
               endpoint_url = CASE WHEN ${input.endpointUrl !== undefined}::boolean
                                   THEN ${input.endpointUrl ?? null} ELSE endpoint_url END,
               qualifier = COALESCE(${input.qualifier ?? null}, qualifier),
               region = CASE WHEN ${input.region !== undefined}::boolean THEN ${input.region ?? null} ELSE region END,
               concurrency_limit = CASE WHEN ${input.concurrencyLimit !== undefined}::boolean
                                        THEN ${input.concurrencyLimit ?? null}::int ELSE concurrency_limit END,
               visibility = COALESCE(${input.visibility ?? null}, visibility),
               idle_timeout_s = COALESCE(${input.idleTimeoutS ?? null}::int, idle_timeout_s),
               is_default = COALESCE(${input.isDefault ?? null}::boolean, is_default),
               status = COALESCE(${input.status ?? null}, status),
               updated_at = now()
             WHERE id = ${id} AND workspace_id = ${workspaceId}`;
      });
      return this.get(workspaceId, id);
   }

   async remove(workspaceId: string, id: string): Promise<void> {
      const runtime = await this.get(workspaceId, id);
      if (runtime.kind === 'platform') throw new RuntimeProtected();
      await this.#sql`DELETE FROM agent_runtimes WHERE id = ${id} AND workspace_id = ${workspaceId}`;
   }

   async recordHealth(workspaceId: string, id: string, error: string | null): Promise<void> {
      await this.#sql`
         UPDATE agent_runtimes
            SET last_health_at = now(), last_health_error = ${error},
                status = CASE WHEN status = 'disabled' THEN status
                              WHEN ${error === null}::boolean THEN 'active' ELSE 'unreachable' END,
                updated_at = now()
          WHERE id = ${id} AND workspace_id = ${workspaceId}`;
   }

   async profiles(workspaceId: string, runtimeId: string): Promise<ProfileView[]> {
      const rows = await this.#sql`
         SELECT id, runtime_id, name, env_keys, model_default, timeout_s, max_concurrency, idle_timeout_s
           FROM runtime_profiles
          WHERE workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}
          ORDER BY name`;
      return rows.map(toProfile);
   }

   async saveProfile(
      workspaceId: string,
      runtimeId: string,
      profileId: string | null,
      input: ProfileInput
   ): Promise<ProfileView> {
      await this.get(workspaceId, runtimeId);
      if (input.env && !this.#sealer) throw new RuntimeSealingUnavailable();
      const sealed = input.env && this.#sealer ? this.#sealer.seal(JSON.stringify(input.env)) : null;
      const keys = input.env ? Object.keys(input.env).sort() : null;
      const [row] = profileId
         ? await this.#sql`
              UPDATE runtime_profiles SET
                 name = COALESCE(${input.name ?? null}, name),
                 env_sealed = CASE WHEN ${sealed !== null}::boolean THEN ${sealed}::bytea ELSE env_sealed END,
                 env_keys = COALESCE(${keys}::text[], env_keys),
                 model_default = CASE WHEN ${input.modelDefault !== undefined}::boolean
                                      THEN ${input.modelDefault ?? null} ELSE model_default END,
                 timeout_s = CASE WHEN ${input.timeoutS !== undefined}::boolean
                                  THEN ${input.timeoutS ?? null}::int ELSE timeout_s END,
                 max_concurrency = CASE WHEN ${input.maxConcurrency !== undefined}::boolean
                                        THEN ${input.maxConcurrency ?? null}::int ELSE max_concurrency END,
                 idle_timeout_s = CASE WHEN ${input.idleTimeoutS !== undefined}::boolean
                                       THEN ${input.idleTimeoutS ?? null}::int ELSE idle_timeout_s END,
                 updated_at = now()
               WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}
               RETURNING id, runtime_id, name, env_keys, model_default, timeout_s, max_concurrency, idle_timeout_s`
         : await this.#sql`
              INSERT INTO runtime_profiles (workspace_id, runtime_id, name, env_sealed, env_keys, model_default,
                                            timeout_s, max_concurrency, idle_timeout_s)
              VALUES (${workspaceId}, ${runtimeId}, ${input.name ?? 'default'}, ${sealed}::bytea, ${keys ?? []}::text[],
                      ${input.modelDefault ?? null}, ${input.timeoutS ?? null}, ${input.maxConcurrency ?? null},
                      ${input.idleTimeoutS ?? null})
              RETURNING id, runtime_id, name, env_keys, model_default, timeout_s, max_concurrency, idle_timeout_s`;
      if (!row) throw new RuntimeNotFound();
      return toProfile(row);
   }

   async removeProfile(workspaceId: string, runtimeId: string, profileId: string): Promise<void> {
      const rows = await this.#sql`
         DELETE FROM runtime_profiles
          WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}
         RETURNING id`;
      if (rows.length === 0) throw new RuntimeNotFound();
   }

   /** Binds (or, with a null runtime, unbinds) an agent of this workspace. */
   async bind(workspaceId: string, runtimeId: string | null, agentId: string, profileId: string | null): Promise<void> {
      if (runtimeId) await this.get(workspaceId, runtimeId);
      if (profileId) {
         // `agents.runtime_profile_id` is a plain FK: without this check an
         // agent could be bound to another workspace's profile, and its sealed
         // env would be opened into this workspace's envelope.
         if (!runtimeId) throw new RuntimeNotFound();
         const [profile] = await this.#sql`
            SELECT 1 FROM runtime_profiles
             WHERE id = ${profileId} AND workspace_id = ${workspaceId} AND runtime_id = ${runtimeId}`;
         if (!profile) throw new RuntimeNotFound();
      }
      const rows = await this.#sql`
         UPDATE agents SET runtime_id = ${runtimeId}, runtime_profile_id = ${profileId}, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
          RETURNING id`;
      if (rows.length === 0) throw new RuntimeNotFound();
   }

   /** What a row points at. A platform row names the deployment's own runtime. */
   target(view: RuntimeView, fallback: RuntimeTarget | null): RuntimeTarget | null {
      if (view.kind === 'platform') return fallback ? { ...fallback, id: view.id } : null;
      return {
         id: view.id,
         driver: view.driver,
         arn: view.arn,
         qualifier: view.qualifier,
         region: view.region,
         endpointUrl: view.endpointUrl,
      };
   }
}

/**
 * One platform runtime row per workspace, naming the deployment's own runtime.
 * Idempotent; run at boot. The row carries no target of its own — it resolves
 * to the configured default — and a workspace created after boot simply has
 * none until the next boot, while its tasks use the default target anyway.
 */
export async function syncPlatformRuntime(sql: Sql, target: RuntimeTarget | null): Promise<void> {
   if (!target) return;
   await sql`
      INSERT INTO agent_runtimes (workspace_id, name, kind, driver, qualifier, region, is_default)
      SELECT w.id, 'Berry platform', 'platform', ${target.driver}, ${target.qualifier}, ${target.region},
             NOT EXISTS (SELECT 1 FROM agent_runtimes d WHERE d.workspace_id = w.id AND d.is_default)
        FROM workspaces AS w
       WHERE NOT EXISTS (SELECT 1 FROM agent_runtimes p WHERE p.workspace_id = w.id AND p.kind = 'platform')`;
}
