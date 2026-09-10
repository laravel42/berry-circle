import type { Queryable, Sql } from '../db/pool.ts';
import { ApiError } from '../http/errors.ts';

export type AgentAction = 'assign' | 'mention';
export type AccessScope = 'everyone' | 'admins' | 'listed';

/**
 * Whether this member may hand work to this agent.
 *
 * Owners and admins always may: a scope that could lock every administrator
 * out of an agent would make it unmanageable. A non-member never may.
 */
export async function canUseAgent(
   sql: Queryable,
   input: { workspaceId: string; agentId: string; userId: string; action: AgentAction }
): Promise<boolean> {
   const [row] = await sql`
      SELECT membership.role::text AS role,
             CASE WHEN ${input.action} = 'assign' THEN agent.assign_scope ELSE agent.mention_scope END AS scope,
             EXISTS (SELECT 1 FROM agent_access_members m
                      WHERE m.agent_id = agent.id AND m.user_id = ${input.userId}) AS listed
        FROM agents AS agent
        JOIN workspace_memberships AS membership
          ON membership.workspace_id = agent.workspace_id AND membership.user_id = ${input.userId}
       WHERE agent.id = ${input.agentId} AND agent.workspace_id = ${input.workspaceId}`;
   if (!row) return false;
   if (row.role === 'owner' || row.role === 'admin') return true;
   if (row.scope === 'everyone') return true;
   if (row.scope === 'listed') return row.listed === true;
   return false;
}

export interface AgentAccess {
   assertCanAssign(input: { workspaceId: string; agentId: string; userId: string }): Promise<void>;
}

export function agentAccessGuard(sql: Sql): AgentAccess {
   return {
      async assertCanAssign(input) {
         if (!(await canUseAgent(sql, { ...input, action: 'assign' }))) {
            throw new ApiError(403, 'AGENT_ACCESS_DENIED', 'You may not assign work to this agent.');
         }
      },
   };
}
