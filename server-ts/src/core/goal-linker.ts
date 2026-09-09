import type { Sql } from '../db/pool.ts';
import type { GoalRepository } from './goals.ts';

/**
 * The narrow slice of goal linking the issue mount depends on.
 *
 * The mount only ever wants to clear an issue's goal or link it to one, so it
 * takes this two-method contract rather than the whole `GoalRepository`. It is
 * defined here, beside the adapter that implements it, so the dependency runs
 * mount → core (an HTTP adapter depending on a domain contract) rather than
 * the other way round.
 */
export interface GoalLinker {
   clearIssueGoal(issueId: string): Promise<void>;
   /** False when the goal is not in this workspace. */
   linkIssue(
      workspaceId: string,
      goalId: string,
      issueId: string,
      actorId: string
   ): Promise<boolean>;
}

/**
 * Adapts the goal repository to the narrow `GoalLinker` the issue mount needs.
 *
 * The issue mount only ever wants to clear an issue's goal or link it to one,
 * and the link must be refused when the goal belongs to another workspace —
 * `goalId` on an issue is otherwise accepted and silently discarded. This lives
 * here rather than inline in the composition root because it is domain logic
 * (it reads and writes `goals`/`goal_issues`), not wiring; the root should only
 * construct it.
 */
export function createGoalLinker(sql: Sql, goals: GoalRepository): GoalLinker {
   return {
      async clearIssueGoal(issueId: string): Promise<void> {
         await sql`DELETE FROM goal_issues WHERE issue_id = ${issueId}`;
      },

      async linkIssue(
         workspaceId: string,
         goalId: string,
         issueId: string,
         actorId: string
      ): Promise<boolean> {
         // Scoped here rather than trusted: a goal from another workspace must
         // read as missing, not be linked across the boundary.
         const [goal] = await sql`
            SELECT id FROM goals
             WHERE id = ${goalId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL`;
         if (!goal) return false;
         await goals.linkIssue({
            workspaceId,
            goalId,
            issueId,
            actorId,
            now: new Date().toISOString(),
         });
         return true;
      },
   };
}
