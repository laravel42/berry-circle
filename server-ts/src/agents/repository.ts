import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { SkillRepository } from '../skills/repository.ts';

/**
 * Agents as Berry rows.
 *
 * The port is mostly a subtraction. In Go an agent row is a projection of an
 * external process: `SyncWorkspace` ran before every listing, a detail call
 * runs before every read, and the model, capabilities and status are all
 * copied down from upstream. None of that survives here, because in-process
 * there is no upstream to copy from — an agent is a name, a system prompt and
 * a model, and Berry owns all three.
 *
 * What is deliberately kept is everything a run depends on: the id is stable
 * and referenced by `runs` and by assignment history, an agent is archived
 * rather than deleted, and the protected orchestrator still cannot be removed.
 */

/** One agent, as the product sees it. */
export interface Agent {
   id: string;
   boardId: string | null;
   name: string;
   description: string | null;
   avatarUrl: string | null;
   status: string;
   /** Runtime tool names: the tools Berry gives an agent. */
   capabilities: string[];
   /** Berry-authored capability names the planner matches issues against. */
   skills: string[];
   instructions: string | null;
   modelProvider: string | null;
   modelName: string | null;
   modelTier: string | null;
   limits: unknown;
   /**
    * What this agent may do, as `permissions.ts` reads it.
    *
    * Carried on the resource because the settings page is where a person
    * decides it, and a permission model nobody can see is one nobody audits.
    * Absence is denial, so an unrecognised name here grants nothing.
    */
   permissions: string[];
   protected: boolean;
   /**
    * The member who authored this agent, or null.
    *
    * Null for the agents a workspace seeds by trigger, and for anything made
    * before an agent had an author at all. A screen that needs to name someone
    * responsible says "the workspace" rather than guessing at the reader.
    */
   ownerId: string | null;
   /** Up to three openers a new chat with this agent offers. */
   conversationStarters: string[];
   /** Tasks it may run at once; null leaves the ceiling to the dispatcher. */
   maxConcurrency: number | null;
   /** A seeded role such as 'guide'; null for an ordinary agent. */
   systemRole: string | null;
   archivedAt: string | null;
   labels: string[];
   /** Names only: the values are sealed and never leave the server but in an envelope. */
   envNames: string[];
   access: { assign: string; mention: string };
   createdAt: string;
   updatedAt: string;
}

/** An agent with the load that decides whether it can take work. */
export interface AgentCapability {
   agent: Agent;
   activeRuns: number;
}

export interface AgentCursor {
   name: string;
   id: string;
}

export interface AgentConfigPatch {
   /** Undefined leaves the field alone; null or '' clears it. */
   instructions?: string | null;
   description?: string | null;
   provider?: string | null;
   model?: string | null;
   skills?: string[];
   /** Replaces the whole set; an empty list clears them. */
   starters?: string[];
   /** Null clears the ceiling rather than leaving it unchanged. */
   maxConcurrency?: number | null;
}

export interface CreateAgentInput {
   workspaceId: string;
   name: string;
   description?: string | null;
   instructions?: string | null;
   provider?: string | null;
   model?: string | null;
   skills?: string[];
   avatarUrl?: string | null;
   /** The member authoring it. Absent for anything Berry seeds itself. */
   createdBy?: string | null;
}

/**
 * What the agents list needs about one agent beyond its own row.
 *
 * Load, runtime and recent activity all live in other tables, and a list of
 * thirty agents that fetched them per row would be thirty round trips for one
 * screen. They are read together here instead.
 */
export interface AgentRosterEntry {
   agentId: string;
   ownerId: string | null;
   ownerName: string | null;
   runtimeId: string | null;
   runtimeName: string | null;
   runtimeStatus: string | null;
   running: number;
   queued: number;
   totalRuns: number;
   lastActiveAt: string | null;
   /** One entry per day, oldest first, with no gaps. */
   activity: { day: string; runs: number; failed: number }[];
}

export type Permission = 'product.read' | 'product.write' | 'workspace.admin';

const ROLE_PERMISSIONS: Record<string, Set<Permission>> = {
   owner: new Set(['product.read', 'product.write', 'workspace.admin']),
   admin: new Set(['product.read', 'product.write', 'workspace.admin']),
   member: new Set(['product.read', 'product.write']),
   viewer: new Set(['product.read']),
};

const AGENT_COLUMNS = `
   agent.id, agent.board_id, agent.name, agent.description, agent.avatar_url,
   agent.status, agent.capabilities, agent.skills, agent.instructions,
   agent.model_provider, agent.model_name, agent.model_tier,
   agent.manifest_limits, agent.permissions, agent.protected, agent.system_role, agent.archived_at,
   agent.labels, agent.env_names, agent.assign_scope, agent.mention_scope,
   agent.created_by, agent.conversation_starters, agent.max_concurrency,
   agent.created_at, agent.updated_at`;

/**
 * One agent works one issue at a time.
 *
 * The one-writer rule: eligibility is "has no active run", not a queue depth.
 * Two runs on one agent would interleave two tasks' tool calls in one
 * transcript.
 */
export const MAX_CONCURRENT_RUNS_PER_AGENT = 1;

export class AgentRepository {
   private readonly sql: Sql;
   private readonly newId: () => string;

   constructor(sql: Sql, newId: () => string = randomUUID) {
      this.sql = sql;
      this.newId = newId;
   }

   /** Membership of the workspace, and whether the role permits this. */
   async authorizeWorkspace(
      userId: string,
      workspaceId: string,
      permission: Permission
   ): Promise<{ workspaceId: string; role: string }> {
      const [row] = await this.sql`
         SELECT membership.role::text AS role
           FROM workspace_memberships AS membership
           JOIN workspaces AS workspace
             ON workspace.id = membership.workspace_id AND workspace.deleted_at IS NULL
          WHERE membership.workspace_id = ${workspaceId} AND membership.user_id = ${userId}`;
      if (!row) throw new NotFound();
      if (!ROLE_PERMISSIONS[row.role as string]?.has(permission)) throw new Forbidden();
      return { workspaceId, role: row.role as string };
   }

   /**
    * Authorization reached through the agent rather than through a workspace.
    *
    * The workspace comes from the agent, so a caller cannot name one it
    * happens to belong to and act on an agent from another. An agent nobody
    * can reach is "not found" rather than "forbidden": the alternative lets a
    * caller enumerate which agent ids exist by the error they get.
    */
   async authorizeAgent(
      userId: string,
      agentId: string,
      permission: Permission
   ): Promise<{ workspaceId: string; role: string }> {
      const [row] = await this.sql`
         SELECT workspace_id FROM agents WHERE id = ${agentId} AND workspace_id IS NOT NULL`;
      if (!row) throw new NotFound();
      return this.authorizeWorkspace(userId, row.workspace_id as string, permission);
   }

   /** One page, ordered by name then id — the cursor's key. */
   async list(
      workspaceId: string,
      status: string,
      after: AgentCursor | null,
      limit: number,
      archived = false
   ): Promise<Agent[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)}
           FROM agents AS agent
          WHERE (agent.archived_at IS NULL) = ${!archived}
            AND agent.workspace_id = ${workspaceId}
            AND (${status} = '' OR agent.status = ${status})
            AND (${after === null} OR (agent.name, agent.id) > (${after?.name ?? ''}::text, ${after?.id ?? null}::uuid))
          ORDER BY agent.name ASC, agent.id ASC
          LIMIT ${limit}`;
      return rows.map(toAgent);
   }

   async get(agentId: string, workspaceId: string): Promise<Agent> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)}
           FROM agents AS agent
          WHERE agent.id = ${agentId} AND agent.workspace_id = ${workspaceId}
            AND agent.archived_at IS NULL`;
      if (!row) throw new NotFound();
      return toAgent(row);
   }

   /**
    * Every live agent with its current load.
    *
    * One query rather than one per agent: the planner reads this to choose who
    * to give work to, and a round trip per agent would make the choice cost
    * more than the work.
    */
   async listCapabilities(workspaceId: string): Promise<AgentCapability[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)},
                (SELECT count(*) FROM runs
                  WHERE runs.agent_id = agent.id AND runs.status IN ('queued', 'running'))
                AS active_runs
           FROM agents AS agent
          WHERE agent.workspace_id = ${workspaceId} AND agent.archived_at IS NULL
          ORDER BY agent.protected ASC, agent.name ASC, agent.id ASC
          LIMIT 500`;
      return rows.map((row) => ({ agent: toAgent(row), activeRuns: Number(row.active_runs) }));
   }

   /**
    * Owner, runtime, load and recent activity for every agent in a workspace.
    *
    * Two statements rather than one: the per-agent facts are a row each, and
    * the activity is a bucketed group-by that would otherwise multiply them.
    * The day series is filled in afterwards so every agent carries the same
    * number of points and a sparkline needs no alignment logic of its own.
    */
   async roster(workspaceId: string, days: number): Promise<AgentRosterEntry[]> {
      const span = Math.min(Math.max(Math.trunc(days), 1), 90);
      const rows = await this.sql`
         SELECT agent.id,
                agent.created_by,
                owner.name AS owner_name,
                agent.runtime_id,
                runtime.name AS runtime_name,
                runtime.status AS runtime_status,
                (SELECT count(*) FROM runs
                  WHERE runs.agent_id = agent.id AND runs.status = 'running') AS running,
                (SELECT count(*) FROM runs
                  WHERE runs.agent_id = agent.id AND runs.status = 'queued') AS queued,
                (SELECT count(*) FROM runs WHERE runs.agent_id = agent.id) AS total_runs,
                (SELECT max(COALESCE(runs.completed_at, runs.started_at, runs.created_at))
                   FROM runs WHERE runs.agent_id = agent.id) AS last_active_at
           FROM agents AS agent
           LEFT JOIN users AS owner ON owner.id = agent.created_by
           LEFT JOIN agent_runtimes AS runtime ON runtime.id = agent.runtime_id
          WHERE agent.workspace_id = ${workspaceId}
          ORDER BY agent.name ASC, agent.id ASC
          LIMIT 500`;

      const buckets = await this.sql`
         SELECT agent_id,
                to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
                count(*)::int AS runs,
                count(*) FILTER (WHERE status = 'failed')::int AS failed
           FROM runs
          WHERE workspace_id = ${workspaceId}
            AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${span - 1})
          GROUP BY 1, 2`;

      const byAgent = new Map<string, Map<string, { runs: number; failed: number }>>();
      for (const bucket of buckets) {
         const agentId = bucket.agent_id as string;
         const own = byAgent.get(agentId) ?? new Map();
         own.set(bucket.day as string, { runs: Number(bucket.runs), failed: Number(bucket.failed) });
         byAgent.set(agentId, own);
      }

      const today = new Date();
      const series: string[] = [];
      for (let back = span - 1; back >= 0; back -= 1) {
         const day = new Date(
            Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back)
         );
         series.push(day.toISOString().slice(0, 10));
      }

      return rows.map((row) => {
         const own = byAgent.get(row.id as string);
         return {
            agentId: row.id as string,
            ownerId: (row.created_by as string | null) ?? null,
            ownerName: (row.owner_name as string | null) ?? null,
            runtimeId: (row.runtime_id as string | null) ?? null,
            runtimeName: (row.runtime_name as string | null) ?? null,
            runtimeStatus: (row.runtime_status as string | null) ?? null,
            running: Number(row.running),
            queued: Number(row.queued),
            totalRuns: Number(row.total_runs),
            lastActiveAt: toRFC3339(row.last_active_at as string | null),
            activity: series.map((day) => ({
               day,
               runs: own?.get(day)?.runs ?? 0,
               failed: own?.get(day)?.failed ?? 0,
            })),
         };
      });
   }

   /**
    * Creates an agent.
    *
    * There is nothing to spawn — the row is the agent. Earlier the substrate
    * owned the identity and Berry discovered it by syncing, which is why
    * authoring one was not a route the product had at all.
    */
   async create(input: CreateAgentInput): Promise<Agent> {
      const id = this.newId();
      const [row] = await this.sql`
         INSERT INTO agents (
            id, workspace_id, board_id, name, description, avatar_url,
            created_by,
            status, capabilities, skills, instructions, model_provider, model_name
         ) VALUES (
            ${id}, ${input.workspaceId}, NULL, ${input.name},
            ${input.description ?? null}, ${input.avatarUrl ?? null},
            ${input.createdBy ?? null},
            -- Available on creation: Berry owns the agent's availability now,
            -- and nothing else will ever set it. 'unknown' would be a lie
            -- about a row whose state is entirely known.
            'available', ARRAY[]::text[], ${input.skills ?? []},
            ${input.instructions ?? null}, ${input.provider ?? null}, ${input.model ?? null}
         )
         RETURNING ${this.sql.unsafe(AGENT_COLUMNS.replaceAll('agent.', ''))}`.catch(classifyWrite);
      return toAgent(row!);
   }

   /**
    * Writes the configuration Berry authors.
    *
    * The model is written here. Berry used to read it back from the substrate
    * after pushing it; there is nothing to read it back from now, so a config
    * save that did not store it would silently do nothing.
    */
   async setConfig(agentId: string, workspaceId: string, patch: AgentConfigPatch): Promise<Agent> {
      const setsInstructions = patch.instructions !== undefined;
      const setsDescription = patch.description !== undefined;
      const setsModel = patch.model !== undefined;
      const setsSkills = patch.skills !== undefined;
      const setsStarters = patch.starters !== undefined;
      const setsConcurrency = patch.maxConcurrency !== undefined;

      const updated = await this.sql`
         UPDATE agents SET
            instructions = CASE WHEN ${setsInstructions}
               THEN ${patch.instructions ?? null}::text ELSE instructions END,
            description = CASE WHEN ${setsDescription}
               THEN ${patch.description ?? null}::text ELSE description END,
            model_provider = CASE WHEN ${setsModel}
               THEN ${patch.provider ?? null}::text ELSE model_provider END,
            model_name = CASE WHEN ${setsModel}
               THEN ${patch.model ?? null}::text ELSE model_name END,
            skills = CASE WHEN ${setsSkills}
               THEN ${patch.skills ?? []}::text[] ELSE skills END,
            conversation_starters = CASE WHEN ${setsStarters}
               THEN ${patch.starters ?? []}::text[] ELSE conversation_starters END,
            -- Null is a value here, not an omission: clearing the ceiling and
            -- leaving it alone are different requests.
            max_concurrency = CASE WHEN ${setsConcurrency}
               THEN ${patch.maxConcurrency ?? null}::integer ELSE max_concurrency END,
            -- Stamped because the prompt is now applied where it is stored:
            -- there is no upstream copy that could be behind this one.
            instructions_synced_at = CASE WHEN ${setsInstructions}
               THEN now() ELSE instructions_synced_at END,
            updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (updated.count !== 1) throw new NotFound();
      return this.get(agentId, workspaceId);
   }

   /**
    * Archives an agent.
    *
    * Never a delete. A Berry agent id is referenced by every run it made and
    * by assignment history, and those have to keep naming somebody. The
    * protected orchestrator refuses even this — a workspace without one has
    * nothing to fall back to when no other agent can take a task.
    */
   /**
    * Replaces what an agent may do.
    *
    * A whole set rather than a patch: permissions are read as a set at every
    * enforcement point, and a partial update would leave a caller unsure
    * whether an absent name was "leave it" or "revoke it". The application
    * drops names it does not know, so an unrecognised one grants nothing here
    * either.
    */
   async setPermissions(
      agentId: string,
      workspaceId: string,
      permissions: string[]
   ): Promise<Agent> {
      const [row] = await this.sql`
         UPDATE agents AS agent
            SET permissions = ${permissions}, updated_at = now()
          WHERE agent.id = ${agentId} AND agent.workspace_id = ${workspaceId}
            AND agent.archived_at IS NULL
          RETURNING ${this.sql.unsafe(AGENT_COLUMNS)}`;
      if (!row) throw new NotFound();
      return toAgent(row);
   }

   async archive(agentId: string, workspaceId: string, now: Date): Promise<void> {
      const [row] = await this.sql`
         SELECT protected FROM agents
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
      if (!row) throw new NotFound();
      if (row.protected === true) throw new Forbidden();

      await this.sql`
         UPDATE agents SET archived_at = ${now.toISOString()}, updated_at = ${now.toISOString()}
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
   }

   async restore(agentId: string, workspaceId: string): Promise<Agent> {
      // Restoring a live agent is what the caller wanted, so no row updated is
      // not an error; `get` then answers NotFound only for a missing agent.
      await this.sql`
         UPDATE agents SET archived_at = NULL, updated_at = now()
          WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NOT NULL`;
      return this.get(agentId, workspaceId);
   }

   /**
    * A new agent with the same configuration, skills and MCP servers.
    *
    * Sealed env travels too (same workspace, same key). Runs, history and the
    * protected flag stay with the original.
    */
   async copy(agentId: string, workspaceId: string): Promise<Agent> {
      const id = this.newId();
      await this.sql.begin(async (transaction) => {
         const tx = transaction as unknown as Sql;
         const inserted = await tx`
            INSERT INTO agents (id, workspace_id, board_id, name, description, avatar_url, status,
                                capabilities, skills, instructions, model_provider, model_name, permissions,
                                labels, env_sealed, env_names, assign_scope, mention_scope)
            SELECT ${id}, workspace_id, NULL, left(name, 93) || ' (copy)', description,
                   -- An uploaded avatar is served from the original's id, so it
                   -- does not travel; an external URL does.
                   CASE WHEN avatar_url ~ '^https?://' THEN avatar_url ELSE NULL END,
                   'available', capabilities, skills, instructions, model_provider, model_name, permissions,
                   labels, env_sealed, env_names, assign_scope, mention_scope
              FROM agents WHERE id = ${agentId} AND workspace_id = ${workspaceId} AND archived_at IS NULL`;
         if (inserted.count !== 1) throw new NotFound();
         await SkillRepository.copyBindings(tx, agentId, id);
         await McpServerRepository.copyForAgent(tx, agentId, id);
      });
      return this.get(id, workspaceId);
   }

   /** The workspace's live guide agent, if it has one. */
   async guide(workspaceId: string): Promise<Agent | null> {
      const [row] = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)} FROM agents AS agent
          WHERE agent.workspace_id = ${workspaceId} AND agent.system_role = 'guide'
            AND agent.archived_at IS NULL`;
      return row ? toAgent(row) : null;
   }
}

function toAgent(row: Record<string, unknown>): Agent {
   return {
      id: row.id as string,
      boardId: (row.board_id as string | null) ?? null,
      name: row.name as string,
      description: (row.description as string | null) ?? null,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      status: row.status as string,
      capabilities: (row.capabilities as string[] | null) ?? [],
      skills: (row.skills as string[] | null) ?? [],
      instructions: (row.instructions as string | null) ?? null,
      modelProvider: (row.model_provider as string | null) ?? null,
      modelName: (row.model_name as string | null) ?? null,
      modelTier: (row.model_tier as string | null) ?? null,
      limits: row.manifest_limits ?? null,
      permissions: (row.permissions as string[] | null) ?? [],
      protected: row.protected === true,
      ownerId: (row.created_by as string | null) ?? null,
      conversationStarters: (row.conversation_starters as string[] | null) ?? [],
      maxConcurrency: row.max_concurrency === null ? null : Number(row.max_concurrency),
      systemRole: (row.system_role as string | null) ?? null,
      archivedAt: toRFC3339(row.archived_at as string | null),
      labels: (row.labels as string[] | null) ?? [],
      envNames: (row.env_names as string[] | null) ?? [],
      access: {
         assign: (row.assign_scope as string | null) ?? 'everyone',
         mention: (row.mention_scope as string | null) ?? 'everyone',
      },
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/** A constraint violation is a domain outcome, not a server fault. */
function classifyWrite(error: unknown): never {
   const code = (error as { code?: string })?.code;
   if (code === '23503') throw new NotFound();
   if (code === '23505') throw new Conflict();
   throw error;
}
