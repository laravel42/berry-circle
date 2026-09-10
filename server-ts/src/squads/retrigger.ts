import type { EnqueueTask } from '../agents/seams.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import type { Run } from '../runs/ledger.ts';
import { onRunTerminal } from '../runs/terminal-hooks.ts';

export interface DelegationInput {
   workspaceId: string;
   parentIssueId: string;
   memberAgentId: string;
   title: string;
   description: string;
}

/**
 * A leader hands one piece of its squad's issue to an agent member.
 *
 * The member must be an agent on the roster of the squad that owns the
 * parent, in the same workspace; anyone else is simply not found, so the tool
 * cannot be used to hand work to an agent the squad does not include.
 */
export async function delegateToMember(
   deps: { sql: Sql; issues: IssueRepository },
   input: DelegationInput
): Promise<{ issueId: string; identifier: string }> {
   const [parent] = await deps.sql`
      SELECT i.board_id, i.priority, sq.squad_id,
             -- The person who gave the parent to the squad asked for this work,
             -- so a sub-issue the leader carves out of it is filed in their name.
             COALESCE(sq.assigned_by, i.created_by) AS requested_by
        FROM issues i
        JOIN boards b ON b.id = i.board_id AND b.workspace_id = ${input.workspaceId}
        JOIN issue_squads sq ON sq.issue_id = i.id AND sq.workspace_id = ${input.workspaceId}
        JOIN squads s ON s.id = sq.squad_id AND s.archived_at IS NULL
        JOIN squad_members m ON m.squad_id = sq.squad_id AND m.member_type = 'agent'
                             AND m.member_id = ${input.memberAgentId}
       WHERE i.id = ${input.parentIssueId}`;
   if (!parent) throw new NotFound();
   const created = await deps.issues.create({
      boardId: parent.board_id as string,
      title: input.title.slice(0, 500),
      description: input.description || null,
      status: 'todo',
      priority: parent.priority as string,
      sortOrder: 0,
      dueDate: null,
      assignee: { type: 'agent', id: input.memberAgentId },
      project: null,
      createdBy: parent.requested_by as string,
   });
   await deps.sql`
      INSERT INTO squad_delegations (child_issue_id, parent_issue_id, squad_id, workspace_id, member_agent_id)
      VALUES (${created.issue.id}, ${input.parentIssueId}, ${parent.squad_id as string}, ${input.workspaceId},
              ${input.memberAgentId})`;
   return { issueId: created.issue.id, identifier: created.issue.identifier };
}

/**
 * A member finishing a delegated sub-issue wakes the leader on the parent.
 *
 * Idempotent per child run: `last_notified_run_id` is claimed with a
 * conditional update, so a hook firing twice (an idempotent cancel) enqueues
 * once.
 */
export function registerSquadRetrigger(deps: { sql: Sql; enqueue: EnqueueTask }): () => void {
   return onRunTerminal(async (run: Run) => {
      if (!run.issueId) return;
      const [claimed] = await deps.sql`
         UPDATE squad_delegations d SET last_notified_run_id = ${run.id}
           FROM squads s
          WHERE d.child_issue_id = ${run.issueId} AND s.id = d.squad_id AND s.archived_at IS NULL
            AND d.last_notified_run_id IS DISTINCT FROM ${run.id}::uuid
         RETURNING d.parent_issue_id, d.workspace_id, s.leader_agent_id,
                   (SELECT name FROM agents WHERE id = d.member_agent_id) AS member_name`;
      if (!claimed) return;
      try {
         await deps.enqueue(deps.sql, {
            workspaceId: claimed.workspace_id as string,
            agentId: claimed.leader_agent_id as string,
            issueId: claimed.parent_issue_id as string,
            kind: 'agent',
            source: 'squad',
            prompt:
               `${(claimed.member_name as string | null) ?? 'A member'} finished a delegated sub-issue with status ${run.status}.` +
               (run.summary ? `\n\n<member_result>\n${run.summary}\n</member_result>` : '') +
               '\n\nDecide whether more delegation is needed, or report the combined result.',
         });
      } catch (error) {
         // A refuses a second run on a busy parent (ActiveRunExists). Release the
         // claim so the wake-up is not recorded as delivered when it was not; a
         // later terminal notification for this child run can then retry.
         await deps.sql`
            UPDATE squad_delegations SET last_notified_run_id = NULL
             WHERE child_issue_id = ${run.issueId} AND last_notified_run_id = ${run.id}`;
         throw error;
      }
   });
}
