import { z } from 'zod';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import type { AgentToolDefinition } from '../runtime/agent-tools/registry.ts';
import { delegateToMember } from './retrigger.ts';

const input = z.object({
   memberId: z.string().uuid(),
   title: z.string().trim().min(1).max(500),
   description: z.string().max(20_000).default(''),
});

/**
 * `delegate_to_member`: only the leader of the squad that owns the task's issue
 * may call it, and only for an agent member of that squad (delegateToMember
 * enforces the latter). Everything else is a tool error, never a created issue.
 */
export function delegateTool(deps: { sql: Sql; issues: IssueRepository }): AgentToolDefinition<typeof input> {
   return {
      description: 'Create a sub-issue assigned to an agent member of your squad.',
      scope: 'task:write',
      inputSchema: input,
      async handler(context, args) {
         const { workspaceId, issueId, agentId } = context.task;
         if (!issueId) throw new Error('delegation needs a task on an issue');
         const [lead] = await deps.sql`
            SELECT 1 FROM issue_squads i JOIN squads s ON s.id = i.squad_id AND s.archived_at IS NULL
             WHERE i.issue_id = ${issueId} AND s.workspace_id = ${workspaceId} AND s.leader_agent_id = ${agentId}`;
         if (!lead) throw new Error('only the squad leader may delegate');
         return delegateToMember(deps, {
            workspaceId,
            parentIssueId: issueId,
            memberAgentId: args.memberId,
            title: args.title,
            description: args.description,
         });
      },
   };
}
