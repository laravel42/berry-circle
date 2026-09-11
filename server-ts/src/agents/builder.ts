import { z } from 'zod';
import type { Sql } from '../db/pool.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import type { McpServerRepository } from '../mcp/repository.ts';
import { mcpTransportSchema } from '../runtime/envelope.ts';
import type { SkillRepository } from '../skills/repository.ts';
import type { AgentRepository } from './repository.ts';
import type { CompleteFn } from './seams.ts';

/**
 * Drafting an agent from a short conversation, then creating it.
 *
 * Each turn asks the completion runtime (workstream A, injected) for a whole
 * draft, validated by `agentDraftSchema`, and keeps it, so a person refines a
 * draft rather than restarting and can apply an earlier one.
 */

export const agentDraftSchema = z.object({
   name: z.string().trim().min(1).max(100),
   description: z.string().max(5000).default(''),
   instructions: z.string().max(20_000).default(''),
   skills: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .max(20)
      .default([]),
   mcp: z
      .array(
         z.object({
            name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
            url: z
               .string()
               .url()
               .max(2000)
               .refine((u) => /^https?:\/\//.test(u), 'url must be http(s)'),
            transport: mcpTransportSchema.default('streamable_http'),
         })
      )
      .max(10)
      .default([]),
   model: z.string().max(200).nullable().default(null),
});
export type AgentDraft = z.infer<typeof agentDraftSchema>;

export class BuilderUnavailable extends Error {
   override readonly name = 'BuilderUnavailable';
}

/** A draft with MCP servers, applied by someone who may not manage MCP servers. */
export class BuilderMcpForbidden extends Error {
   override readonly name = 'BuilderMcpForbidden';
}

export interface BuilderSession {
   id: string;
   status: string;
   appliedAgentId: string | null;
   drafts: { id: string; turn: number; prompt: string; draft: AgentDraft }[];
}

const SYSTEM = (skillNames: string[]): string =>
   'You design an agent for Berry, a workspace where people and AI agents work on tasks together. ' +
   'Return a JSON object for the agent: a short name, a one-line description, instructions written ' +
   'to the agent in the second person (how it should approach every task, what to produce, what to avoid), ' +
   'the skills it should use, MCP servers it needs (only if the person named one), and a model id or null. ' +
   `Use only these existing skills: ${skillNames.length > 0 ? skillNames.join(', ') : '(none)'}.`;

export class AgentBuilder {
   readonly #sql: Sql;
   readonly #complete: CompleteFn | null;
   readonly #skills: SkillRepository;
   readonly #agents: AgentRepository;
   readonly #mcp: McpServerRepository;

   constructor(options: {
      sql: Sql;
      complete: CompleteFn | null;
      skills: SkillRepository;
      agents: AgentRepository;
      mcp: McpServerRepository;
   }) {
      this.#sql = options.sql;
      this.#complete = options.complete;
      this.#skills = options.skills;
      this.#agents = options.agents;
      this.#mcp = options.mcp;
   }

   async start(workspaceId: string, userId: string): Promise<{ id: string; status: string; drafts: [] }> {
      const [row] = await this.#sql`
         INSERT INTO agent_builder_sessions (workspace_id, created_by) VALUES (${workspaceId}, ${userId})
         RETURNING id, status`;
      return { id: row?.id as string, status: row?.status as string, drafts: [] };
   }

   async get(workspaceId: string, sessionId: string): Promise<BuilderSession> {
      const [session] = await this.#sql`
         SELECT id, status, applied_agent_id FROM agent_builder_sessions
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
      if (!session) throw new NotFound();
      const drafts = await this.#sql`
         SELECT id, turn, prompt, draft FROM agent_builder_drafts
          WHERE session_id = ${sessionId} AND workspace_id = ${workspaceId}
          ORDER BY turn`;
      return {
         id: session.id as string,
         status: session.status as string,
         appliedAgentId: (session.applied_agent_id as string | null) ?? null,
         drafts: drafts.map((d) => ({
            id: d.id as string,
            turn: Number(d.turn),
            prompt: d.prompt as string,
            draft: d.draft as AgentDraft,
         })),
      };
   }

   async turn(
      workspaceId: string,
      sessionId: string,
      prompt: string
   ): Promise<{ draftId: string; draft: AgentDraft; unknownSkills: string[] }> {
      const complete = this.#complete;
      if (!complete) throw new BuilderUnavailable('no completion runtime is configured');
      const session = await this.get(workspaceId, sessionId);
      if (session.status !== 'drafting') throw new Conflict();
      const known = (await this.#skills.list(workspaceId)).map((skill) => skill.name);
      const previous = session.drafts.at(-1);
      const draft = await complete({
         workspaceId,
         purpose: 'agent_builder',
         system: SYSTEM(known),
         prompt: previous
            ? `The current draft is:\n${JSON.stringify(previous.draft, null, 2)}\n\nChange it as asked:\n${prompt}`
            : prompt,
         schema: agentDraftSchema,
      });
      const [row] = await this.#sql`
         INSERT INTO agent_builder_drafts (session_id, workspace_id, turn, prompt, draft)
         VALUES (${sessionId}, ${workspaceId}, ${session.drafts.length + 1}, ${prompt},
                 ${this.#sql.json(draft as never)})
         RETURNING id`.catch((error: unknown) => {
         // Two turns racing for the same number: the second one is told to retry.
         if ((error as { code?: string }).code === '23505') throw new Conflict();
         throw error;
      });
      await this.#sql`UPDATE agent_builder_sessions SET updated_at = now() WHERE id = ${sessionId}`;
      return {
         draftId: row?.id as string,
         draft,
         unknownSkills: draft.skills.filter((name) => !known.includes(name)),
      };
   }

   async apply(
      workspaceId: string,
      sessionId: string,
      draftId: string,
      userId: string,
      options: { allowMcp: boolean }
   ): Promise<{ agentId: string }> {
      // The draft is checked before the session is claimed: a wrong draftId must
      // leave the session open, not close it with no agent.
      const [row] = await this.#sql`
         SELECT d.draft FROM agent_builder_drafts d
          WHERE d.id = ${draftId} AND d.session_id = ${sessionId} AND d.workspace_id = ${workspaceId}`;
      if (!row) {
         await this.get(workspaceId, sessionId); // NotFound for a missing session
         throw new NotFound();
      }
      const draft = agentDraftSchema.parse(row.draft);
      // Checked before the claim, so a refused apply leaves the session open.
      if (draft.mcp.length > 0 && !options.allowMcp) {
         throw new BuilderMcpForbidden('settings.write is required');
      }
      // The conditional update is the once-only guard against a double apply.
      const [claimed] = await this.#sql`
         UPDATE agent_builder_sessions SET status = 'applied', updated_at = now()
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId} AND status = 'drafting'
          RETURNING id`;
      if (!claimed) throw new Conflict();
      try {
         const agent = await this.#agents.create({
            workspaceId,
            name: draft.name,
            description: draft.description,
            instructions: draft.instructions,
         });
         const skills = await this.#skills.list(workspaceId);
         for (const name of draft.skills) {
            const skill = skills.find((candidate) => candidate.name === name);
            if (skill) await this.#skills.setBinding(workspaceId, agent.id, skill.id, true);
         }
         for (const server of draft.mcp) {
            await this.#mcp.create(
               workspaceId,
               { agentId: agent.id, ...server, headers: {}, viaGateway: false, enabled: true },
               userId
            );
         }
         await this.#sql`
            UPDATE agent_builder_sessions SET applied_agent_id = ${agent.id}
             WHERE id = ${sessionId} AND workspace_id = ${workspaceId}`;
         return { agentId: agent.id };
      } catch (error) {
         // Reopen the session, so a failed apply (a duplicate MCP name, say) can be retried.
         await this.#sql`
            UPDATE agent_builder_sessions SET status = 'drafting', updated_at = now()
             WHERE id = ${sessionId} AND workspace_id = ${workspaceId} AND applied_agent_id IS NULL`;
         throw error;
      }
   }

   async discard(workspaceId: string, sessionId: string): Promise<void> {
      const updated = await this.#sql`
         UPDATE agent_builder_sessions SET status = 'discarded', updated_at = now()
          WHERE id = ${sessionId} AND workspace_id = ${workspaceId} AND status = 'drafting'`;
      if (updated.count !== 1) {
         await this.get(workspaceId, sessionId); // NotFound for a missing session
         throw new Conflict();
      }
   }
}
