import type { Sql } from '../db/pool.ts';
import { BedrockChat, readJson } from '../llm/bedrock-chat.ts';

/**
 * Who does the work a plan just created, and starting it.
 *
 * Compiling a plan wrote tasks nobody is holding. The planner is not asked to
 * name an agent — it describes the capability a task needs and nothing else —
 * so without this step every plan ends the same way: a board of unassigned
 * work that will never move, because a run needs an agent and nothing was
 * going to give it one.
 *
 * Routing is the orchestrator's job (ADR-0008), so the orchestrator agent's
 * own model is what reads the roster and the tasks and decides. It answers
 * with assignments only; it does not get to invent an agent or a task, and
 * anything it names that is not on both lists is dropped rather than trusted.
 */

export interface TriageResult {
   assigned: number;
   started: number;
   /** Tasks the orchestrator declined to route, by title. */
   unassigned: string[];
}

export class TriageUnavailable extends Error {
   override readonly name = 'TriageUnavailable';
}

interface RosterAgent {
   id: string;
   name: string;
   description: string | null;
   capabilities: string[];
}

interface TriageTask {
   id: string;
   number: number;
   title: string;
   description: string | null;
   status: string;
   capabilities: string[];
}

/** What a run is told when nobody typed instructions for it. */
function instructionsFor(task: TriageTask): string {
   return task.description?.trim()
      ? `${task.title}\n\n${task.description.trim()}`
      : task.title;
}

const SYSTEM = `You route work to agents in a software workspace.

You are given a roster of agents and a list of tasks. Assign each task to the
one agent best suited to it, judging by the agent's description and what the
task needs. Prefer an agent whose stated purpose matches the task over a
general one.

Assign every task you can. Leave a task out only when no agent on the roster
could plausibly do it — an unassigned task is work nobody will pick up, so
omitting one is a real cost, not a safe default.

Answer with JSON only — no prose, no code fence. The shape is:

{ "assignments": [ { "taskId": "...", "agentId": "..." } ] }

Use ids exactly as given. Do not invent an id, and do not name an agent or a
task that is not on the lists.`;

export interface PlanTriageOptions {
   sql: Sql;
   /** The AWS region Bedrock is called in. */
   region: string;
   defaultModel: string;
   /** Injected by tests; production builds one from the region. */
   chat?: BedrockChat;
   timeoutMs?: number;
}

export class PlanTriage {
   readonly #sql: Sql;
   readonly #chat: BedrockChat;
   readonly #defaultModel: string;
   readonly #timeoutMs: number;

   constructor(options: PlanTriageOptions) {
      this.#sql = options.sql;
      this.#chat =
         options.chat ??
         new BedrockChat({
            region: options.region,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
         });
      this.#defaultModel = options.defaultModel;
      this.#timeoutMs = options.timeoutMs ?? 60_000;
   }

   /** The tasks a plan compiled, with the capabilities compile labelled them with. */
   async tasks(planId: string): Promise<TriageTask[]> {
      const rows = await this.#sql<
         Array<{
            id: string;
            number: number;
            title: string;
            description: string | null;
            status: string;
            capabilities: string[] | null;
         }>
      >`
         SELECT i.id, i.number, i.title, i.description, i.status::text AS status,
                array_remove(array_agg(l.name), NULL) AS capabilities
           FROM plan_issues pi
           JOIN issues i ON i.id = pi.issue_id AND i.deleted_at IS NULL
           LEFT JOIN issue_label_memberships m ON m.issue_id = i.id
           LEFT JOIN issue_labels l ON l.id = m.label_id
          WHERE pi.plan_id = ${planId}
            AND i.assignee_id IS NULL
          GROUP BY i.id, i.number, i.title, i.description, i.status
          ORDER BY i.number`;
      return rows.map((row) => ({ ...row, capabilities: row.capabilities ?? [] }));
   }

   /**
    * Who may be given work.
    *
    * The orchestrator is excluded from its own roster: it is the one deciding,
    * and a router that routes to itself is a loop rather than an assignment.
    */
   async roster(workspaceId: string): Promise<RosterAgent[]> {
      const rows = await this.#sql<
         Array<{ id: string; name: string; description: string | null; capabilities: string[] | null }>
      >`
         SELECT id, name, description, capabilities
           FROM agents
          WHERE workspace_id = ${workspaceId}
            AND archived_at IS NULL
            AND status <> 'offline'
            AND protected = false
          ORDER BY name`;
      return rows.map((row) => ({ ...row, capabilities: row.capabilities ?? [] }));
   }

   /** The orchestrator's own model, or the deployment default. */
   async #model(workspaceId: string): Promise<string> {
      const [row] = await this.#sql<Array<{ model_name: string | null }>>`
         SELECT model_name FROM agents
          WHERE workspace_id = ${workspaceId} AND protected = true AND archived_at IS NULL
          ORDER BY updated_at DESC LIMIT 1`;
      return row?.model_name || this.#defaultModel;
   }

   /** Asks the orchestrator to route, returning only assignments it may make. */
   async #decide(
      workspaceId: string,
      tasks: TriageTask[],
      roster: RosterAgent[],
      signal?: AbortSignal
   ): Promise<Map<string, string>> {
      const user = JSON.stringify({
         agents: roster.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description ?? '',
         })),
         tasks: tasks.map((task) => ({
            id: task.id,
            title: task.title,
            description: (task.description ?? '').slice(0, 600),
            needs: task.capabilities,
         })),
      });

      const result = await this.#chat
         .chat({
            model: await this.#model(workspaceId),
            system: SYSTEM,
            user,
            json: true,
            ...(signal ? { signal } : {}),
         })
         .catch((cause: unknown) => {
            throw new TriageUnavailable(
               `the orchestrator could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`
            );
         });

      const content = result.text;
      if (content.trim() === '') {
         throw new TriageUnavailable('the orchestrator answered with nothing to read');
      }

      // Read leniently: a model asked for JSON may still fence it, and losing
      // an assignment to punctuation would leave every task unowned.
      const parsed = readJson(content);
      if (parsed === null) {
         throw new TriageUnavailable('the orchestrator did not answer with JSON');
      }

      // Only ids from both lists survive. A model naming an agent that does not
      // exist would otherwise write a dangling assignee, and one naming a task
      // outside this plan would reach across into work it was not shown.
      const agentIds = new Set(roster.map((agent) => agent.id));
      const taskIds = new Set(tasks.map((task) => task.id));
      const decided = new Map<string, string>();
      const rows = (parsed as { assignments?: unknown }).assignments;
      if (Array.isArray(rows)) {
         for (const row of rows) {
            const { taskId, agentId } = (row ?? {}) as { taskId?: unknown; agentId?: unknown };
            if (typeof taskId !== 'string' || typeof agentId !== 'string') continue;
            if (!taskIds.has(taskId) || !agentIds.has(agentId)) continue;
            decided.set(taskId, agentId);
         }
      }
      return decided;
   }

   /**
    * Route a compiled plan's tasks, then start the ones that can run.
    *
    * A task that is `blocked` is waiting on another task, so starting it would
    * put an agent to work on something whose input does not exist yet. It is
    * assigned and left alone; the run comes when what it waits for is done.
    *
    * Assignment is committed before any run is admitted. A model call that
    * fails halfway should leave work owned by somebody rather than half-routed
    * and unowned.
    */
   async triage(input: {
      planId: string;
      workspaceId: string;
      admit: (task: { issueId: string; agentId: string; instructions: string }) => Promise<void>;
      signal?: AbortSignal;
   }): Promise<TriageResult> {
      const tasks = await this.tasks(input.planId);
      if (tasks.length === 0) return { assigned: 0, started: 0, unassigned: [] };

      const roster = await this.roster(input.workspaceId);
      if (roster.length === 0) {
         throw new TriageUnavailable('this workspace has no agent that can take work');
      }

      const decided = await this.#decide(input.workspaceId, tasks, roster, input.signal);

      let assigned = 0;
      for (const task of tasks) {
         const agentId = decided.get(task.id);
         if (!agentId) continue;
         await this.#sql`
            UPDATE issues
               SET assignee_type = 'agent', assignee_id = ${agentId}, updated_at = now()
             WHERE id = ${task.id} AND assignee_id IS NULL`;
         assigned += 1;
      }

      let started = 0;
      for (const task of tasks) {
         const agentId = decided.get(task.id);
         if (!agentId || task.status === 'blocked') continue;
         try {
            await input.admit({
               issueId: task.id,
               agentId,
               instructions: instructionsFor(task),
            });
            started += 1;
         } catch {
            // One task failing to start is not a reason to leave the rest
            // unstarted; it keeps its agent and can be run by hand.
         }
      }

      return {
         assigned,
         started,
         unassigned: tasks.filter((task) => !decided.has(task.id)).map((task) => task.title),
      };
   }
}
