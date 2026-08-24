import type { Issue } from '@/data/issues';
import { z } from 'zod';
import { apiFetch } from './api';
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
   createdBy: actorRefSchema.nullish(),
   createdAt: z.string(),
   updatedAt: z.string(),
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
};

export async function patchBoardIssue(issueId: string, patch: IssuePatchBody): Promise<void> {
   try {
      await apiFetch(`/api/v1/issues/${issueId}`, {
         method: 'PATCH',
         body: JSON.stringify(patch),
      });
   } catch {
      // Optimistic updates; failed PATCH leaves local state until refresh.
   }
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

   if (apiIssue.dueDate) {
      issue.dueDate = apiIssue.dueDate;
   }
   if (apiIssue.activeRunId) {
      issue.activeRunId = apiIssue.activeRunId;
   }

   return issue;
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
}): Promise<Issue> {
   const body: Record<string, unknown> = {
      boardId: input.boardId,
      title: input.title,
      status: apiStatusFromUi(input.statusId),
      priority: apiPriorityFromUi(input.priorityId),
   };
   if (input.description) {
      body.description = input.description;
   }
   if (input.assignee) {
      body.assignee = input.assignee;
   }

   const json: unknown = await apiFetch('/api/v1/issues', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey() },
      body: JSON.stringify(body),
   });
   const parsed = issueSchema.safeParse(json);
   if (!parsed.success) {
      throw new Error('Create issue response was not recognized');
   }
   const issue = toUiIssue(parsed.data);
   if (!issue) {
      throw new Error('Created issue could not be displayed');
   }
   return issue;
}
