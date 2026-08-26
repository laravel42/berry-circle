import { z } from 'zod';
import { BerryApiError, apiFetch } from './api';
import { actorRefSchema, connectionSchema, newIdempotencyKey } from './api-schemas';

/**
 * Goals: the outcome a plan serves. A goal lists the tasks linked to it, the
 * workflows that automate it, the approvals it is waiting on and the plans
 * that proposed it; `progress` is only on a single read.
 */

export const goalStatusSchema = z.enum([
   'draft',
   'planned',
   'active',
   'blocked',
   'completed',
   'cancelled',
]);

export const goalProgressSchema = z.object({
   issuesTotal: z.number(),
   issuesDone: z.number(),
   issuesCancelled: z.number().default(0),
   workflowsActive: z.number(),
   approvalsPending: z.number(),
});

export const goalSchema = z.object({
   id: z.string(),
   workspaceId: z.string(),
   projectId: z.string().nullish(),
   title: z.string(),
   description: z.string().nullish(),
   status: goalStatusSchema,
   source: z.string(),
   sourcePrompt: z.string().nullish(),
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

export const goalWorkflowRefSchema = z.object({
   id: z.string(),
   name: z.string(),
   status: z.string(),
   triggerType: z.string().nullish(),
   risk: z.string().nullish(),
   version: z.number().nullish(),
   updatedAt: z.string().nullish(),
});

export const goalApprovalRefSchema = z.object({
   id: z.string(),
   kind: z.string(),
   risk: z.string().nullish(),
   title: z.string(),
   status: z.string(),
   issueId: z.string().nullish(),
   workflowId: z.string().nullish(),
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
export type GoalWorkflowRef = z.infer<typeof goalWorkflowRefSchema>;
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

export interface CreateGoalInput {
   workspaceId: string;
   title: string;
   description?: string;
   projectId?: string;
}

export async function createGoal(input: CreateGoalInput): Promise<Goal> {
   const body: Record<string, string> = { workspaceId: input.workspaceId, title: input.title };
   if (input.description) body.description = input.description;
   if (input.projectId) body.projectId = input.projectId;
   const json: unknown = await apiFetch('/api/v1/goals', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   return parseGoal(json);
}

export interface GoalPatch {
   title?: string;
   description?: string | null;
   status?: GoalStatus;
   projectId?: string | null;
}

/** Throws so an optimistic edit can be put back; the store decides. */
export async function patchGoal(goalId: string, patch: GoalPatch): Promise<Goal> {
   const json: unknown = await apiFetch(`/api/v1/goals/${encodeURIComponent(goalId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
   });
   return parseGoal(json);
}

/** Archives the goal; its tasks keep their links. Needs `settings.write`. */
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

export function listGoalWorkflows(goalId: string): Promise<GoalWorkflowRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/workflows`, goalWorkflowRefSchema);
}

export function listGoalApprovals(goalId: string): Promise<GoalApprovalRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/approvals`, goalApprovalRefSchema);
}

export function listGoalPlans(goalId: string): Promise<GoalPlanRef[]> {
   return listNodes(`/api/v1/goals/${encodeURIComponent(goalId)}/plans`, goalPlanRefSchema);
}

export async function linkGoalIssue(goalId: string, issueRef: string): Promise<void> {
   await apiFetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/issues/${encodeURIComponent(issueRef)}`,
      { method: 'PUT' }
   );
}

export async function unlinkGoalIssue(goalId: string, issueRef: string): Promise<void> {
   await apiFetch(
      `/api/v1/goals/${encodeURIComponent(goalId)}/issues/${encodeURIComponent(issueRef)}`,
      { method: 'DELETE' }
   );
}

// ---------------------------------------------------------------------------
// Reading a goal

export function describeGoalStatus(status: string): string {
   switch (status) {
      case 'draft':
         return 'Draft';
      case 'planned':
         return 'Planned';
      case 'active':
         return 'Active';
      case 'blocked':
         return 'Blocked';
      case 'completed':
         return 'Completed';
      case 'cancelled':
         return 'Cancelled';
      default:
         return status;
   }
}

/**
 * The statuses a person may move a goal to from where it is. `blocked` is
 * the dispatcher's alone, and a finished goal stays finished.
 */
export function goalTransitions(status: GoalStatus): { status: GoalStatus; label: string }[] {
   switch (status) {
      case 'draft':
         return [
            { status: 'planned', label: 'Mark planned' },
            { status: 'active', label: 'Start goal' },
            { status: 'cancelled', label: 'Cancel goal' },
         ];
      case 'planned':
         return [
            { status: 'active', label: 'Start goal' },
            { status: 'cancelled', label: 'Cancel goal' },
         ];
      case 'active':
         return [
            { status: 'completed', label: 'Complete goal' },
            { status: 'cancelled', label: 'Cancel goal' },
         ];
      case 'blocked':
         return [
            { status: 'active', label: 'Resume goal' },
            { status: 'completed', label: 'Complete goal' },
            { status: 'cancelled', label: 'Cancel goal' },
         ];
      default:
         return [];
   }
}

/** Human wording for a refused goal call. */
export function describeGoalFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'GOAL_TRANSITION_INVALID': {
            const details = error.details as { from?: string; to?: string } | null;
            if (details?.from && details?.to) {
               return `A goal cannot go from ${describeGoalStatus(details.from).toLowerCase()} to ${describeGoalStatus(details.to).toLowerCase()}.`;
            }
            return 'That status change is not allowed.';
         }
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

/** "3 of 5 tasks done · 1 workflow active · 2 approvals pending". */
export function describeGoalProgress(progress: GoalProgress | null | undefined): string {
   if (!progress) return 'No tasks yet';
   const parts: string[] = [];
   parts.push(
      progress.issuesTotal === 0
         ? 'no tasks yet'
         : `${progress.issuesDone} of ${progress.issuesTotal} task${progress.issuesTotal === 1 ? '' : 's'} done`
   );
   if (progress.workflowsActive > 0) {
      parts.push(
         `${progress.workflowsActive} workflow${progress.workflowsActive === 1 ? '' : 's'} active`
      );
   }
   if (progress.approvalsPending > 0) {
      parts.push(
         `${progress.approvalsPending} approval${progress.approvalsPending === 1 ? '' : 's'} pending`
      );
   }
   return parts.join(' · ');
}
