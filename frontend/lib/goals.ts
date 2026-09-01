import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { actorRefSchema, connectionSchema } from './api-schemas';

/**
 * Goals: the tasks one plan compile produced, inside one project. Nothing
 * authors a goal — not its title, not its membership, not its status, which is
 * a function of the tasks under it. See
 * `docs/adr/0010-goals-as-derived-task-groups.md`.
 */

export const goalStatusSchema = z.enum(['planned', 'active', 'blocked', 'completed']);

/**
 * `draft` and `cancelled` were reachable only while a goal could be written by
 * hand. They are folded into the four rather than rejected, so the page keeps
 * working against a database that migration 038 has not reached yet; this and
 * `wireGoalStatusSchema` can go once it has.
 */
const RETIRED_STATUS: Record<string, GoalStatus> = {
   draft: 'planned',
   cancelled: 'completed',
};

const wireGoalStatusSchema = z.preprocess(
   (value) =>
      typeof value === 'string' && value in RETIRED_STATUS ? RETIRED_STATUS[value] : value,
   goalStatusSchema
);

export const goalProgressSchema = z.object({
   issuesTotal: z.number(),
   issuesDone: z.number(),
   issuesCancelled: z.number().default(0),
   approvalsPending: z.number(),
});

export const goalSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   projectId: z.string().nullish(),
   title: z.string(),
   description: z.string().nullish(),
   status: wireGoalStatusSchema,
   createdBy: actorRefSchema.nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
   startedAt: z.string().nullish(),
   completedAt: z.string().nullish(),
   progress: goalProgressSchema.nullish(),
});

const goalConnectionSchema = connectionSchema(goalSchema);

export const goalIssueRefSchema = z.object({
   id: z.string(),
   identifier: z.string(),
   title: z.string(),
   status: z.string(),
   linkedAt: z.string().nullish(),
});

export const goalApprovalRefSchema = z.object({
   id: z.string(),
   kind: z.string(),
   risk: z.string().nullish(),
   title: z.string(),
   status: z.string(),
   issueId: z.string().nullish(),
   requestedAt: z.string().nullish(),
});

export const goalPlanRefSchema = z.object({
   id: z.string(),
   status: z.string(),
   source: z.string().nullish(),
   version: z.number().nullish(),
   generationStatus: z.string().nullish(),
   validationStatus: z.string().nullish(),
   compileStatus: z.string().nullish(),
   createdAt: z.string(),
});

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalProgress = z.infer<typeof goalProgressSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type GoalIssueRef = z.infer<typeof goalIssueRefSchema>;
export type GoalApprovalRef = z.infer<typeof goalApprovalRefSchema>;
export type GoalPlanRef = z.infer<typeof goalPlanRefSchema>;

function parseGoal(json: unknown): Goal {
   const parsed = goalSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Goal response was not recognized');
   }
   return parsed.data;
}

export interface GoalsQuery {
   query?: string;
   status?: GoalStatus;
   projectId?: string;
   first?: number;
}

export async function listWorkspaceGoals(
   workspaceId: string,
   query: GoalsQuery = {}
): Promise<Goal[]> {
   const collected: Goal[] = [];
   const limit = query.first ?? 200;
   let after: string | undefined;
   for (let page = 0; page < 20; page += 1) {
      const params = new URLSearchParams({ workspaceId, first: String(Math.min(limit, 100)) });
      if (query.query) params.set('query', query.query);
      if (query.status) params.set('status', query.status);
      if (query.projectId) params.set('projectId', query.projectId);
      if (after) params.set('after', after);
      const json: unknown = await apiFetch(`/api/v1/goals?${params.toString()}`);
      const parsed = goalConnectionSchema.safeParse(json);
      if (!parsed.success) {
         throw new Error('Goal list was not recognized');
      }
      collected.push(...parsed.data.nodes);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) break;
      if (collected.length >= limit) break;
      after = endCursor;
   }
   return collected.slice(0, limit);
}

/** Goals for the store; a failed read leaves the list empty rather than broken. */
export async function loadWorkspaceGoals(workspaceId: string): Promise<Goal[]> {
   if (!workspaceId) return [];
   try {
      return await listWorkspaceGoals(workspaceId);
   } catch {
      return [];
   }
}

export async function getGoal(goalId: string, signal?: AbortSignal): Promise<Goal> {
   const json: unknown = await apiFetch(`/api/v1/goals/${encodeURIComponent(goalId)}`, undefined, {
      signal,
   });
   return parseGoal(json);
}

/**
 * Archives the goal; its tasks keep their links. Needs `settings.write`.
 *
 * The only write left. A goal is not created, renamed or moved from here —
 * compiling a plan makes one — but a grouping that has outlived its use should
 * still be retirable.
 */
export async function archiveGoal(goalId: string): Promise<void> {
   await apiFetch(`/api/v1/goals/${encodeURIComponent(goalId)}`, { method: 'DELETE' });
}

async function listNodes<T extends z.ZodType>(path: string, node: T): Promise<z.infer<T>[]> {
   const json: unknown = await apiFetch(path);
   const parsed = z.object({ nodes: z.array(node) }).safeParse(json);
   if (!parsed.success) return [];
   return parsed.data.nodes;
}

export function listGoalIssues(goalId: string): Promise<GoalIssueRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/issues`, goalIssueRefSchema);
}

export function listGoalApprovals(goalId: string): Promise<GoalApprovalRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/approvals`, goalApprovalRefSchema);
}

export function listGoalPlans(goalId: string): Promise<GoalPlanRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/plans`, goalPlanRefSchema);
}

// ---------------------------------------------------------------------------
// Reading a goal

export function describeGoalStatus(status: string): string {
   switch (status) {
      case 'planned':
         return 'Planned';
      case 'active':
         return 'In Progress';
      case 'blocked':
         return 'Blocked';
      case 'completed':
         return 'Done';
      default:
         return status;
   }
}

/**
 * Why the goal is in that state. Nobody set it, so the page has to say what
 * the tasks are doing — otherwise "Blocked" looks like a decision someone made
 * and the reader goes looking for who made it.
 */
export function describeGoalStatusReason(status: string): string {
   switch (status) {
      case 'planned':
         return 'Every task is still waiting to start.';
      case 'active':
         return 'Work has started and some tasks are still open.';
      case 'blocked':
         return 'Every task still open is blocked, so nothing can move.';
      case 'completed':
         return 'Every task is done or cancelled.';
      default:
         return '';
   }
}

/** Human wording for a refused goal call. */
export function describeGoalFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'PROJECT_NOT_FOUND':
            return 'That project does not exist in this workspace.';
         case 'GOAL_NOT_FOUND':
         case 'NOT_FOUND':
            return 'The goal could not be found.';
         case 'FORBIDDEN':
            return 'You are not allowed to do that to this goal.';
         case 'VALIDATION_FAILED': {
            const details = error.details as { fields?: { message?: string }[] } | null;
            const first = details?.fields?.[0]?.message;
            return first ?? error.message;
         }
         default:
            return error.message;
      }
   }
   return 'The goal request failed.';
}

/** "3 of 5 tasks done · 2 approvals pending". */
export function describeGoalProgress(progress: GoalProgress | null | undefined): string {
   if (!progress) return 'No tasks yet';
   const parts: string[] = [];
   parts.push(
      progress.issuesTotal === 0
         ? 'no tasks yet'
         : `${progress.issuesDone} of ${progress.issuesTotal} task${progress.issuesTotal === 1 ? '' : 's'} done`
   );
   if (progress.approvalsPending > 0) {
      parts.push(
         `${progress.approvalsPending} approval${progress.approvalsPending === 1 ? '' : 's'} pending`
      );
   }
   return parts.join(' · ');
}
