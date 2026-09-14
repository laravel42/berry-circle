import type { Sql } from '../db/pool.ts';
import { canUseAgent } from './access.ts';
import { parseMentions } from './mentions.ts';
import type { EnqueueTask } from './seams.ts';

/**
 * Which agents a person's comment starts, and starting them exactly once.
 *
 * Rules: only a person's comment triggers (an agent's result comment must not
 * loop); a mentioned live agent of this workspace is a target unless its
 * mention scope refuses the author; a mentioned squad targets its leader; a
 * comment with no mentions on an agent-assigned issue goes to the assignee;
 * and each agent is targeted at most once per comment.
 */

export type TriggerReason = 'mention' | 'squad_leader' | 'reply_to_assignee';

export interface TriggerPlan {
   targets: { agentId: string; agentName: string; reason: TriggerReason }[];
   refused: { agentId: string; agentName: string; reason: 'no_access' }[];
}

export interface TriggerInput {
   workspaceId: string;
   issueId: string;
   authorId: string;
   body: string;
}

export async function planCommentTriggers(sql: Sql, input: TriggerInput): Promise<TriggerPlan> {
   const mentions = parseMentions(input.body);
   const candidates: { agentId: string; reason: TriggerReason }[] = [];
   for (const agentId of mentions.agents) candidates.push({ agentId, reason: 'mention' });
   if (mentions.squads.length > 0) {
      const leaders = await sql`
         SELECT leader_agent_id FROM squads
          WHERE id IN ${sql(mentions.squads)} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      for (const row of leaders) {
         candidates.push({ agentId: row.leader_agent_id as string, reason: 'squad_leader' });
      }
   }
   if (mentions.agents.length === 0 && mentions.squads.length === 0) {
      const [issue] = await sql`
         SELECT i.assignee_id FROM issues i JOIN boards b ON b.id = i.board_id
          WHERE i.id = ${input.issueId} AND b.workspace_id = ${input.workspaceId}
            AND i.assignee_type = 'agent'`;
      if (issue?.assignee_id) {
         candidates.push({ agentId: issue.assignee_id as string, reason: 'reply_to_assignee' });
      }
   }

   const plan: TriggerPlan = { targets: [], refused: [] };
   const seen = new Set<string>();
   for (const candidate of candidates) {
      if (seen.has(candidate.agentId)) continue;
      seen.add(candidate.agentId);
      const [agent] = await sql`
         SELECT name FROM agents
          WHERE id = ${candidate.agentId} AND workspace_id = ${input.workspaceId} AND archived_at IS NULL`;
      // Not in this workspace, or archived: say nothing about it, not even a refusal.
      if (!agent) continue;
      const allowed = await canUseAgent(sql, {
         workspaceId: input.workspaceId,
         agentId: candidate.agentId,
         userId: input.authorId,
         action: 'mention',
      });
      const agentName = agent.name as string;
      if (allowed) plan.targets.push({ agentId: candidate.agentId, agentName, reason: candidate.reason });
      else plan.refused.push({ agentId: candidate.agentId, agentName, reason: 'no_access' });
   }
   return plan;
}

export async function fireCommentTriggers(
   sql: Sql,
   enqueue: EnqueueTask,
   input: {
      workspaceId: string;
      issueId: string;
      /** Who wrote the comment. What the agent files while answering is theirs. */
      authorId: string;
      commentId: string;
      body: string;
      plan: TriggerPlan;
   }
): Promise<string[]> {
   const runs: string[] = [];
   for (const target of input.plan.targets) {
      const [claimed] = await sql`
         INSERT INTO comment_run_triggers (comment_id, agent_id, workspace_id, reason)
         VALUES (${input.commentId}, ${target.agentId}, ${input.workspaceId}, ${target.reason})
         ON CONFLICT DO NOTHING RETURNING agent_id`;
      if (!claimed) continue;
      // A refuses a second task on an issue that already has one (ActiveRunExists).
      // Release the claim on any failure, so it never records a run that was not
      // queued and a later retry of this comment can still fire.
      const release = async (error: unknown): Promise<never> => {
         await sql`
            DELETE FROM comment_run_triggers
             WHERE comment_id = ${input.commentId} AND agent_id = ${target.agentId}`;
         throw error;
      };
      const intro =
         target.reason === 'reply_to_assignee'
            ? 'A person replied on the issue you are assigned:'
            : 'You were mentioned in a comment on this issue:';
      const { runId } = await enqueue(sql, {
         workspaceId: input.workspaceId,
         agentId: target.agentId,
         issueId: input.issueId,
         kind: 'agent',
         // A's source vocabulary has no reply value; the reason is kept on the row.
         source: target.reason === 'squad_leader' ? 'squad' : 'mention',
         // The commenter is knowable here, so a task the agent files while
         // answering is attributed to them rather than to nobody.
         requestedBy: input.authorId,
         prompt: `${intro}\n\n<comment>\n${input.body.replaceAll('</comment>', '</ comment>')}\n</comment>`,
      }).catch(release);
      await sql`
         UPDATE comment_run_triggers SET run_id = ${runId}
          WHERE comment_id = ${input.commentId} AND agent_id = ${target.agentId}`;
      runs.push(runId);
   }
   return runs;
}

export interface CommentTriggers {
   preview(input: TriggerInput): Promise<TriggerPlan>;
   fire(input: TriggerInput & { commentId: string }): Promise<void>;
}

export function commentTriggers(deps: {
   sql: Sql;
   enqueue: EnqueueTask;
   report: (error: unknown) => void;
}): CommentTriggers {
   return {
      preview: (input) => planCommentTriggers(deps.sql, input),
      async fire(input) {
         try {
            const plan = await planCommentTriggers(deps.sql, input);
            await fireCommentTriggers(deps.sql, deps.enqueue, { ...input, plan });
         } catch (error) {
            // The comment is already saved; a failed trigger is reported, not a failed comment.
            deps.report(error);
         }
      },
   };
}
