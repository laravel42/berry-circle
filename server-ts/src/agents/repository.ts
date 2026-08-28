import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { Conflict, Forbidden, NotFound } from '../identity/errors.ts';

/**
 * Agents as Berry rows.
 *
 * The port is mostly a subtraction. In Go an agent row is a projection of an
 * external process: `SyncWorkspace` ran before every listing, a detail call
 * runs before every read, and the model, capabilities and status are all
 * copied down from upstream. None of that survives here, because under ADK
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
   /** Runtime tool names. Under ADK these are the tools Berry gives an agent. */
   capabilities: string[];
   /** Berry-authored capability names the planner matches issues against. */
   skills: string[];
   instructions: string | null;
   modelProvider: string | null;
   modelName: string | null;
   modelTier: string | null;
   limits: unknown;
   protected: boolean;
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
   agent.manifest_limits, agent.protected, agent.created_at, agent.updated_at`;

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
      limit: number
   ): Promise<Agent[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(AGENT_COLUMNS)}
           FROM agents AS agent
          WHERE agent.archived_at IS NULL
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
            status, capabilities, skills, instructions, model_provider, model_name
         ) VALUES (
            ${id}, ${input.workspaceId}, NULL, ${input.name},
            ${input.description ?? null}, ${input.avatarUrl ?? null},
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
      protected: row.protected === true,
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
