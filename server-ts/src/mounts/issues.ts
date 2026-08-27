import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import {
   UPDATED_CURSOR_KEYS,
   decodeCursor,
   encodeCursor,
   type UpdatedCursor,
} from '../http/cursor.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import {
   escapeSearchLiteral,
   issueCursorScope,
   parseCanonicalUUID,
   type AssigneeInput,
   type Issue,
   type IssueRelations,
   type IssueRepository,
} from '../core/issues.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/issues`, ported from server/internal/handlers/issues.
 *
 * Reads only, for now. Creating and updating an issue publishes to the
 * realtime hub, and a mount that wrote correctly but published nothing would
 * leave every open board silently stale — so those routes wait for the hub
 * rather than shipping with a no-op broadcaster. See ROUTING.md.
 */

const STATUS_TO_DB: Record<string, string> = {
   backlog: 'backlog',
   todo: 'todo',
   inProgress: 'in_progress',
   inReview: 'in_review',
   done: 'done',
   blocked: 'blocked',
   cancelled: 'cancelled',
};

const PRIORITIES = new Set(['none', 'urgent', 'high', 'medium', 'low']);

const PAGE_PARAMS = new Set([
   'first',
   'after',
   'boardId',
   'status',
   'priority',
   'assigneeType',
   'assigneeId',
   'query',
]);

export interface IssueOptions {
   sessions: SessionService;
   issues: IssueRepository;
   boards: BoardRepository;
}

export function issueMounts(options: IssueOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const { issues, boards } = options;

   route.get('/', async (context) => {
      const query = parseIssueQuery(new URL(context.req.url));

      // The board is authorized before the filter is used, so an unreadable
      // board cannot be probed through the shape of its results.
      await boards
         .authorize(context.get('user').id, query.boardId, 'product.read')
         .catch(rethrow(true));

      const scope = issueCursorScope(query);
      const after = query.after === '' ? null : decodeIssueCursor(query.after, scope);

      const rows = await issues.list({
         boardId: query.boardId,
         statuses: query.statuses,
         priorities: query.priorities,
         assignee: query.assignee,
         query: query.query,
         after,
         limit: query.first + 1,
      });
      const hasNextPage = rows.length > query.first;
      const nodes = hasNextPage ? rows.slice(0, query.first) : rows;

      const relations = await issues.loadRelations(nodes.map((issue) => issue.id));
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map((issue) => serializeIssue(issue, relations.get(issue.id))),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { updatedAt: last.updatedAt, id: last.id }) : null,
         },
      });
   });

   route.get('/:issueRef', async (context) => {
      // Fetched before authorization because the reference may be an
      // identifier, and the issue's own id is what the check needs.
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrow(false));
      await issues.authorize(context.get('user').id, issue.id, 'product.read').catch(rethrow(false));

      const relations = await issues.loadRelations([issue.id]);
      return json(serializeIssue(issue, relations.get(issue.id)));
   });

   return [{ prefix: '/api/v1/issues', handler: route }];
}

interface IssueQuery {
   first: number;
   after: string;
   boardId: string;
   statuses: string[] | null;
   priorities: string[] | null;
   assignee: AssigneeInput | null;
   query: string | null;
}

/**
 * The list filter.
 *
 * Statuses and priorities are sorted, because the cursor scope is a hash of
 * this filter — leaving them in the order the caller wrote them would make
 * `status=todo,done` and `status=done,todo` two different pages of the same
 * query, and a cursor from one invalid against the other.
 */
function parseIssueQuery(url: URL): IssueQuery {
   const seen = new Set<string>();
   for (const name of url.searchParams.keys()) {
      if (!PAGE_PARAMS.has(name) || seen.has(name)) throw invalidQuery();
      seen.add(name);
   }

   let first = 50;
   const rawFirst = url.searchParams.get('first');
   if (rawFirst !== null && rawFirst !== '') {
      const parsed = /^[+-]?\d+$/.test(rawFirst) ? Number(rawFirst) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
         throw invalidQuery([
            { path: '/query/first', code: 'invalid', message: 'first must be an integer from 1 to 100.' },
         ]);
      }
      first = parsed;
   }

   const after = url.searchParams.get('after');
   if (after !== null && after === '') throw invalidCursor();

   const boardId = parseCanonicalUUID(url.searchParams.get('boardId') ?? '');
   if (boardId === null) {
      throw invalidQuery([
         { path: '/query/boardId', code: 'invalid_string', message: 'boardId must be a UUID.' },
      ]);
   }

   let statuses: string[] | null = null;
   if (url.searchParams.has('status')) {
      const values = parseCSV(url.searchParams.get('status') ?? '');
      statuses = values.map((value) => {
         const mapped = STATUS_TO_DB[value];
         if (mapped === undefined) throw invalidQuery();
         return mapped;
      });
      statuses.sort();
   }

   let priorities: string[] | null = null;
   if (url.searchParams.has('priority')) {
      priorities = parseCSV(url.searchParams.get('priority') ?? '');
      for (const value of priorities) if (!PRIORITIES.has(value)) throw invalidQuery();
      priorities.sort();
   }

   // Both halves of an assignee filter or neither: an id without a type could
   // match a user and an agent that happen to share it.
   const hasType = url.searchParams.has('assigneeType');
   const hasId = url.searchParams.has('assigneeId');
   if (hasType !== hasId) throw invalidQuery();
   let assignee: AssigneeInput | null = null;
   if (hasType) {
      const type = url.searchParams.get('assigneeType') ?? '';
      if (type !== 'user' && type !== 'agent') throw invalidQuery();
      const id = parseCanonicalUUID(url.searchParams.get('assigneeId') ?? '');
      if (id === null) throw invalidQuery();
      assignee = { type, id };
   }

   let query: string | null = null;
   if (url.searchParams.has('query')) {
      const raw = url.searchParams.get('query') ?? '';
      const length = [...raw].length;
      if (length < 1 || length > 200) throw invalidQuery();
      query = escapeSearchLiteral(raw);
   }

   return { first, after: after ?? '', boardId, statuses, priorities, assignee, query };
}

/** Go's strings.Split on ",", with every element required to be non-empty. */
function parseCSV(raw: string): string[] {
   const values = raw.split(',');
   if (values.length === 0 || values.some((value) => value === '')) throw invalidQuery();
   return values;
}

function decodeIssueCursor(after: string, scope: string): UpdatedCursor {
   try {
      // Keyed updatedAt, not createdAt: issues page by recency of change, and
      // a cursor issued by either server has to decode on the other.
      return decodeCursor<UpdatedCursor>(after, scope, UPDATED_CURSOR_KEYS);
   } catch {
      throw invalidCursor();
   }
}

function invalidQuery(fields?: FieldError[]): ApiError {
   return new ApiError(
      400,
      'INVALID_REQUEST',
      'The request query is invalid.',
      fields ? { fields } : null
   );
}

function invalidCursor(): ApiError {
   return new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
}

/**
 * Domain failures in this mount's words.
 *
 * `boardScoped` picks which resource a missing row describes: a filter naming
 * an unreadable board reports the board missing, while a direct read of an
 * issue reports the issue.
 */
function rethrow(boardScoped: boolean): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof NotFound) {
         throw new ApiError(404, 'NOT_FOUND', boardScoped ? 'Board not found.' : 'Issue not found.');
      }
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
      }
      throw error;
   };
}

/** Field order follows Go's struct declaration, which is what goes on the wire. */
function serializeIssue(issue: Issue, relations: IssueRelations | undefined): Record<string, unknown> {
   return {
      id: issue.id,
      boardId: issue.boardId,
      number: issue.number,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      sortOrder: issue.sortOrder,
      dueDate: issue.dueDate,
      assignee: issue.assignee,
      activeRunId: issue.activeRunId,
      project: issue.project,
      createdBy: issue.createdBy,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      goal: relations?.goal ?? null,
      origin: relations?.origin ?? null,
      // Always arrays: the frontend maps over them without a guard.
      dependsOn: relations?.dependsOn ?? [],
      blocks: relations?.blocks ?? [],
   };
}
