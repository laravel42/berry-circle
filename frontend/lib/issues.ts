import type { Issue, IssueDependencyRef } from '@/data/issues';
import { health, type Project } from '@/data/projects';
import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { currentUser } from '@/data/users';
import { useProjectsStore } from '@/store/projects-store';
import { Box } from 'lucide-react';
import { z } from 'zod';
import { apiFetch, BerryApiError } from './api';
import { actorRefSchema, connectionSchema, newIdempotencyKey } from './api-schemas';
import type { User } from '@/data/users';
import {
   apiPriorityFromUi,
   apiStatusFromUi,
   toUiUser,
   uiPriorityFromApi,
   uiStatusFromApi,
} from './catalog';

export function assigneeToApi(user: User | null): { type: 'user' | 'agent'; id: string } | null {
   if (!user) return null;
   return {
      type: user.role === 'Application' ? 'agent' : 'user',
      id: user.id,
   };
}

/**
 * Load and create issues through `apiFetch`.
 *
 * List requires a board id from session bootstrap (or `NEXT_PUBLIC_BOARD_ID`).
 * Failed or malformed responses return [] so the board/list UI stays bootable.
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/**
 * A task another task waits on, or that waits on it. The server currently
 * serialises these with Go field names (`ID`, `Identifier`, `Title`,
 * `Status`) where the contract says `id`, `identifier`, `title`, `status`;
 * both spellings are read until that is fixed, so a dependency never
 * vanishes from the panel over a capital letter.
 */
const dependencyRefSchema = z.preprocess(
   (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      return {
         id: record.id ?? record.ID,
         identifier: record.identifier ?? record.Identifier,
         title: record.title ?? record.Title,
         status: record.status ?? record.Status,
      };
   },
   z.object({
      id: z.string(),
      identifier: z.string(),
      title: z.string().default(''),
      status: z.string(),
   })
);

const dependencyListsSchema = z.object({
   dependsOn: z.array(dependencyRefSchema).default([]),
   blocks: z.array(dependencyRefSchema).default([]),
});

const issueSchema = z.object({
   id: z.string(),
   boardId: z.string(),
   number: z.number(),
   identifier: z.string(),
   title: z.string(),
   description: z.string().nullish(),
   status: z.string(),
   priority: z.string(),
   sortOrder: z.number(),
   dueDate: z.string().nullish(),
   assignee: actorRefSchema.nullish(),
   activeRunId: z.string().nullish(),
   project: z.object({ id: z.string(), name: z.string() }).nullish(),
   createdBy: actorRefSchema.nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
   goal: z.object({ id: z.string(), title: z.string() }).nullish(),
   dependsOn: z.array(dependencyRefSchema).default([]),
   blocks: z.array(dependencyRefSchema).default([]),
   parentId: z.string().nullish(),
   stage: z.number().nullish(),
   statusId: z.string().nullish(),
   childProgress: z.object({ total: z.number(), done: z.number() }).nullish(),
});

const issueConnectionSchema = connectionSchema(issueSchema);

type ApiIssue = z.infer<typeof issueSchema>;

export function rankFromSortOrder(sortOrder: number): string {
   const magnitude = Math.abs(sortOrder).toString().padStart(15, '0');
   return `${sortOrder < 0 ? '0' : '1'}${magnitude}`;
}

export function sortOrderFromRank(rank: string): number {
   const sign = rank.startsWith('0') ? -1 : 1;
   return sign * Number.parseInt(rank.slice(1), 10);
}

const SORT_ORDER_GAP = 1000;

/** Integer sort key between two board positions (API `sortOrder`). */
export function sortOrderBetween(before?: number, after?: number): number {
   if (before === undefined && after === undefined) return SORT_ORDER_GAP;
   if (before === undefined) return Math.max(0, after! - SORT_ORDER_GAP);
   if (after === undefined) return before + SORT_ORDER_GAP;
   const mid = Math.floor((before + after) / 2);
   if (mid <= before || mid >= after) return before + SORT_ORDER_GAP;
   return mid;
}

export type IssuePatchBody = {
   title?: string;
   status?: string;
   priority?: string;
   sortOrder?: number;
   description?: string | null;
   assignee?: { type: 'user' | 'agent'; id: string } | null;
   goalId?: string | null;
   /** An ISO date, or null to clear it. */
   dueDate?: string | null;
};

/**
 * Rejects on failure so an optimistic update can be reverted. It used to
 * swallow errors, which left a card showing a status the server had refused
 * (a 409 on an illegal transition) until the next refresh.
 */
export async function patchBoardIssue(issueId: string, patch: IssuePatchBody): Promise<void> {
   await apiFetch(`/api/v1/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
   });
}

/**
 * Human wording for a refused patch. The transition error carries the wire
 * statuses it refused, which read better as the board's own labels.
 */
export function describePatchFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      if (error.code === 'INVALID_STATE_TRANSITION') {
         const details = error.details as { from?: string; to?: string } | null;
         if (details?.from && details?.to) {
            const from = uiStatusFromApi(details.from)?.name ?? details.from;
            const to = uiStatusFromApi(details.to)?.name ?? details.to;
            return `Can't move from ${from} to ${to}.`;
         }
      }
      if (error.code === 'APPROVAL_REQUIRED') {
         return 'An approval is pending. The task moves to To do once it is granted.';
      }
      if (error.code === 'GOAL_NOT_FOUND') {
         return 'That goal is not in this workspace.';
      }
      return error.message;
   }
   return 'The change could not be saved.';
}

/** The approval that holds a refused move, when the server names one. */
export function patchFailureApprovalId(error: unknown): string | null {
   if (!(error instanceof BerryApiError) || error.code !== 'APPROVAL_REQUIRED') return null;
   const details = error.details as { approvalId?: unknown } | null;
   return typeof details?.approvalId === 'string' ? details.approvalId : null;
}

export async function getBoardIssue(issueRef: string): Promise<Issue | undefined> {
   try {
      const json: unknown = await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}`);
      const parsed = issueSchema.safeParse(json);
      if (!parsed.success) return undefined;
      return toUiIssue(parsed.data);
   } catch {
      return undefined;
   }
}

export function toUiIssue(apiIssue: ApiIssue): Issue | undefined {
   const uiStatus = uiStatusFromApi(apiIssue.status);
   const uiPriority = uiPriorityFromApi(apiIssue.priority);
   if (!uiStatus || !uiPriority) return undefined;

   const issue: Issue = {
      id: apiIssue.id,
      identifier: apiIssue.identifier,
      title: apiIssue.title,
      description: apiIssue.description ?? '',
      status: uiStatus,
      assignee: apiIssue.assignee ? toUiUser(apiIssue.assignee) : null,
      priority: uiPriority,
      labels: [],
      createdAt: apiIssue.createdAt,
      cycleId: '',
      rank: rankFromSortOrder(apiIssue.sortOrder),
      sortOrder: apiIssue.sortOrder,
   };

   // The API names the project; the UI type carries the whole record, so the
   // rest comes from the projects store. A project the store has not loaded
   // yet still yields a link with its real name — the alternative is an issue
   // that shows no project until an unrelated fetch happens to land first.
   if (apiIssue.project) {
      const known = useProjectsStore
         .getState()
         .projects.find((candidate) => candidate.id === apiIssue.project?.id);
      issue.project = known ?? placeholderProject(apiIssue.project.id, apiIssue.project.name);
   }

   if (apiIssue.dueDate) {
      issue.dueDate = apiIssue.dueDate;
   }
   if (apiIssue.activeRunId) {
      issue.activeRunId = apiIssue.activeRunId;
   }
   issue.goal = apiIssue.goal ?? null;
   issue.dependsOn = apiIssue.dependsOn;
   issue.blocks = apiIssue.blocks;
   issue.parentId = apiIssue.parentId ?? null;
   issue.stage = apiIssue.stage ?? null;
   issue.statusId = apiIssue.statusId ?? null;
   issue.childProgress = apiIssue.childProgress ?? { total: 0, done: 0 };
   // Both were parsed and dropped. The detail page's "created by / created /
   // updated" block is the only thing that reads them, and without them it
   // could only ever have said "unknown".
   issue.createdBy = apiIssue.createdBy ? toUiUser(apiIssue.createdBy) : null;
   issue.updatedAt = apiIssue.updatedAt;
   // Only a person: an agent-authored task is not somebody's "created" tab.
   issue.createdById =
      apiIssue.createdBy && apiIssue.createdBy.type === 'user' ? apiIssue.createdBy.id : null;

   return issue;
}

export function parseApiIssue(json: unknown): Issue | undefined {
   const parsed = issueSchema.safeParse(json);
   return parsed.success ? toUiIssue(parsed.data) : undefined;
}

const inFlight = new Map<string, Promise<Issue[]>>();

async function fetchAllBoardIssues(boardId: string): Promise<Issue[]> {
   const collected: Issue[] = [];

   try {
      let after: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
         const params = new URLSearchParams({
            boardId,
            first: String(PAGE_SIZE),
         });
         if (after) {
            params.set('after', after);
         }

         const json: unknown = await apiFetch(`/api/v1/issues?${params.toString()}`);
         const parsed = issueConnectionSchema.safeParse(json);
         if (!parsed.success) {
            return collected;
         }

         for (const node of parsed.data.nodes) {
            const mapped = toUiIssue(node);
            if (mapped) {
               collected.push(mapped);
            }
         }

         const { hasNextPage, endCursor } = parsed.data.pageInfo;
         if (!hasNextPage || !endCursor || parsed.data.nodes.length === 0) {
            break;
         }
         after = endCursor;
      }

      return collected;
   } catch {
      return collected;
   }
}

/** One in-flight list fetch per board; empty when no board is selected. */
export function loadBoardIssues(boardId: string): Promise<Issue[]> {
   if (!boardId) return Promise.resolve([]);
   const existing = inFlight.get(boardId);
   if (existing) return existing;
   const promise = fetchAllBoardIssues(boardId).finally(() => {
      if (inFlight.get(boardId) === promise) {
         inFlight.delete(boardId);
      }
   });
   inFlight.set(boardId, promise);
   return promise;
}

export async function createBoardIssue(input: {
   boardId: string;
   title: string;
   description?: string;
   statusId: string;
   priorityId: string;
   assignee?: { type: 'user' | 'agent'; id: string };
   projectId?: string;
   /** ISO date. The create modal offers it; the board's quick add does not. */
   dueDate?: string;
}): Promise<Issue> {
   const body: Record<string, unknown> = {
      boardId: input.boardId,
      title: input.title,
      status: apiStatusFromUi(input.statusId),
      priority: apiPriorityFromUi(input.priorityId),
   };
   if (input.dueDate) {
      body.dueDate = input.dueDate;
   }
   if (input.description) {
      body.description = input.description;
   }
   if (input.assignee) {
      body.assignee = input.assignee;
   }
   if (input.projectId) {
      body.projectId = input.projectId;
   }

   const json: unknown = await apiFetch('/api/v1/issues', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   const parsed = issueSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create task response was not recognized');
   }
   const issue = toUiIssue(parsed.data);
   if (!issue) {
      throw new Error('Created task could not be displayed');
   }
   return issue;
}

/**
 * Delete an issue.
 *
 * Unlike the optimistic patch above, a failure is reported rather than
 * swallowed. Removing the card locally after a delete the server refused would
 * show the issue as gone until the next refresh brought it back — and a person
 * who believes something is deleted stops looking for it.
 */
export async function deleteBoardIssue(issueRef: string): Promise<void> {
   await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}`, {
      method: 'DELETE',
   });
}

/**
 * A project record for one the projects store has not loaded.
 *
 * Only the identity is real; everything else is a neutral default. It exists so
 * a freshly loaded issue can show which project it belongs to without waiting
 * on a second request, and it is replaced by the real record as soon as the
 * store has it.
 */
function placeholderProject(id: string, name: string): Project {
   return {
      id,
      name,
      status: status.find((candidate) => candidate.id === 'to-do') ?? status[0],
      icon: Box,
      percentComplete: 0,
      startDate: '',
      lead: currentUser,
      priority: priorities.find((candidate) => candidate.id === 'no-priority') ?? priorities[0],
      health: health.find((candidate) => candidate.id === 'no-update') ?? health[0],
      teamId: '',
      labels: [],
   };
}

/**
 * Link an issue to a project, or unlink it with null.
 *
 * Not routed through patchBoardIssue because that helper swallows failures on
 * purpose — an optimistic field reconciles on the next refresh. A project that
 * silently failed to save is what this whole path was reported for, so the
 * error is raised and the caller decides.
 */
export async function setIssueProject(issueRef: string, projectId: string | null): Promise<void> {
   await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId }),
   });
}

// ---------------------------------------------------------------------------
// Goal and dependencies

/**
 * Link a task to a goal, or unlink it with null. Raised rather than
 * swallowed for the same reason as the project link above. Throws
 * `GOAL_NOT_FOUND` for a goal outside the workspace.
 */
export async function setIssueGoal(issueRef: string, goalId: string | null): Promise<void> {
   await apiFetch(`/api/v1/issues/${encodeURIComponent(issueRef)}`, {
      method: 'PATCH',
      body: JSON.stringify({ goalId }),
   });
}

export interface IssueDependencyLists {
   dependsOn: IssueDependencyRef[];
   blocks: IssueDependencyRef[];
}

function parseDependencyLists(json: unknown): IssueDependencyLists {
   const parsed = dependencyListsSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Dependency response was not recognized');
   }
   return parsed.data;
}

export async function listIssueDependencies(issueRef: string): Promise<IssueDependencyLists> {
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/dependencies`
   );
   return parseDependencyLists(json);
}

/**
 * Make `issueRef` wait on `dependsOn` (an id or identifier). Adding an edge
 * that exists is not an error. Throws `DEPENDENCY_CYCLE` when the blocker
 * already waits on this task, directly or through others, and
 * `ISSUE_NOT_FOUND` for a blocker outside the workspace.
 */
export async function addIssueDependency(
   issueRef: string,
   dependsOn: string
): Promise<IssueDependencyLists> {
   const json: unknown = await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/dependencies`,
      { method: 'POST', body: JSON.stringify({ dependsOn }) }
   );
   return parseDependencyLists(json);
}

export async function removeIssueDependency(issueRef: string, dependsOnId: string): Promise<void> {
   await apiFetch(
      `/api/v1/issues/${encodeURIComponent(issueRef)}/dependencies/${encodeURIComponent(dependsOnId)}`,
      { method: 'DELETE' }
   );
}

/** Human wording for a refused dependency change. */
export function describeDependencyFailure(error: unknown): string {
   if (error instanceof BerryApiError) {
      switch (error.code) {
         case 'DEPENDENCY_CYCLE':
            return 'That would make a loop: the other task already waits on this one, directly or through others.';
         case 'ISSUE_NOT_FOUND':
            return 'No task by that id in this workspace.';
         case 'NOT_FOUND':
            return 'That dependency is already gone.';
         default:
            return error.message;
      }
   }
   return 'The dependency could not be changed.';
}
