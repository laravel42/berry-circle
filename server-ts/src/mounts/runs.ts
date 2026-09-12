import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { BoardRepository } from '../core/boards.ts';
import { RunTerminal, type Run, type RunLedger } from '../runs/ledger.ts';
import {
   ActiveRunExists,
   NoAgentAssigned,
   type RunFilter,
   type RunRepository,
} from '../runs/repository.ts';
import { pathId } from './shared.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/runs`, and the two listings that hang under a board and a task.
 *
 * The run ledger is what a person watches while an agent works and reads back
 * afterwards, so everything here is a projection of `runs` and `run_events`
 * and none of it decides anything. The one exception is `POST` on a task,
 * which admits a run — and that is a database transaction, not a dispatch.
 */

const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const MAX_INSTRUCTIONS = 20_000;

/** One page of events per poll. A run with a long log arrives in order, not at once. */
const EVENT_PAGE = 500;

/**
 * The filters each listing accepts, beyond `first` and `after`.
 *
 * Named rather than open, because an unrecognised parameter is a typo and a
 * listing that ignores it answers a question nobody asked. A task's runs take
 * no `agentId`: the contract does not offer it, and one task's runs rarely
 * span two agents.
 */
const BOARD_FILTERS = ['status', 'agentId'] as const;
const ISSUE_FILTERS = ['status'] as const;

export interface RunOptions {
   sessions: SessionService;
   runs: RunRepository;
   ledger: RunLedger;
   issues: IssueRepository;
   boards: BoardRepository;
   idempotency: IdempotencyStore;
}

export function runMounts(options: RunOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { runs, ledger, issues } = options;

   route.get('/:runId', async (context) => {
      const run = await load(context.req.param('runId'));
      await authorize(context, run, 'product.read');
      return json(serializeRun(run));
   });

   /**
    * Cancellation is a request, not a promise.
    *
    * It returns the run as it stands, which may still be `running`: an
    * in-flight model call is asked to stop, and saying it has stopped before
    * it has would be a lie the ledger would then contradict.
    */
   route.post('/:runId/cancel', async (context) => {
      const run = await load(context.req.param('runId'));
      await authorize(context, run, 'product.write');
      try {
         const cancelled = await ledger.markCancelled(run.id);
         return json(serializeRun(cancelled), 202);
      } catch (error) {
         if (error instanceof RunTerminal) {
            // Already succeeded or failed. Idempotent for a run that is
            // already cancelling or cancelled, which `markCancelled` allows.
            throw new ApiError(409, 'RUN_TERMINAL', 'This run has already finished.');
         }
         throw error;
      }
   });

   /**
    * The run's own event stream.
    *
    * Replayed from `run_events` rather than subscribed to, for the same reason
    * the workspace stream is: the rows are the record, and a reader that
    * missed a minute gets the minute rather than a gap.
    */
   route.get('/:runId/events', async (context) => {
      const run = await load(context.req.param('runId'));
      await authorize(context, run, 'product.read');

      const url = new URL(context.req.url);
      const after = parseAfterSequence(url.searchParams.get('after'), context.req.header('last-event-id'));
      const events = await runs.events(run.id, after, EVENT_PAGE);

      return json({
         events: events.map((event) => ({
            id: event.id,
            type: event.type,
            occurredAt: event.occurredAt,
            boardId: event.boardId,
            issueId: event.issueId,
            runId: event.runId,
            sequence: event.sequence,
            payload: event.payload,
         })),
         // The caller's next `after`. Absent when the page was empty, so a
         // poller holds its position rather than restarting from the top.
         cursor: events.at(-1)?.sequence ?? after,
      });
   });

   return [{ prefix: '/api/v1/runs', handler: route }];

   async function load(raw: string | undefined): Promise<Run> {
      return runs.get(pathId(raw, 'Run')).catch(() => {
         throw ApiError.notFound('Run');
      });
   }

   /** A run is reachable exactly when its task is. */
   async function authorize(
      context: { get: (key: 'user') => { id: string } },
      run: Run,
      scope: 'product.read' | 'product.write'
   ): Promise<void> {
      await issues.authorize(context.get('user').id, run.issueId, scope).catch((error) => {
         // "Not yours" and "does not exist" read the same, so an error cannot
         // be used to discover which run ids are real.
         if (error instanceof NotFound || error instanceof Forbidden) throw ApiError.notFound('Run');
         throw error;
      });
   }
}

/**
 * The listings and the dispatch, which hang under a board and a task.
 *
 * Returned as routers for those mounts to own, the way comments hang under an
 * issue — a run belongs to its task, and `/api/v1/runs` is the shortcut to one
 * you already know the id of.
 */
export function boardRunRoutes(options: RunOptions) {
   const route = new Hono<{ Variables: AuthVariables }>();
   const { runs, boards } = options;

   route.get('/:boardId/runs', async (context) => {
      const boardId = pathId(context.req.param('boardId'), 'Board');
      await boards.authorize(context.get('user').id, boardId, 'product.read').catch(rethrow('Board'));

      const url = new URL(context.req.url);
      const page = parsePageQuery(url, BOARD_FILTERS);
      const filter = parseFilter(url);
      const scope = filterScope(`runs.board.${boardId}`, filter);
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await runs.listByBoard(boardId, after, page.first + 1, filter);
      return json(connection(rows, page.first, scope));
   });

   return route;
}

export function issueRunRoutes(options: RunOptions) {
   const route = new Hono<{ Variables: AuthVariables }>();
   const { runs, issues, idempotency } = options;

   route.get('/:issueRef/runs', async (context) => {
      const issue = await resolveIssue(issues, context.req.param('issueRef'), context.get('user').id, 'product.read');

      const url = new URL(context.req.url);
      const page = parsePageQuery(url, ISSUE_FILTERS);
      const filter = parseFilter(url, { agent: false });
      const scope = filterScope(`runs.issue.${issue.id}`, filter);
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await runs.listByIssue(issue.id, after, page.first + 1, filter);
      return json(connection(rows, page.first, scope));
   });

   route.post('/:issueRef/runs', idempotent(idempotency), async (context) => {
      const issue = await resolveIssue(issues, context.req.param('issueRef'), context.get('user').id, 'product.write');
      const scope = await issues.authorize(context.get('user').id, issue.id, 'product.write');

      // Unknown fields are refused by the decoder, so a typo'd `agent_id` is
      // a 422 rather than a run dispatched to whoever was already assigned.
      const { value: body } = await decodeBody<{ agentId?: string; instructions?: string }>(
         context,
         { agentId: 'string', instructions: 'string' }
      );
      const agentId = optionalId(body.agentId);
      const instructions = optionalInstructions(body.instructions);

      try {
         const run = await runs.admit({
            issueId: issue.id,
            boardId: issue.boardId,
            workspaceId: scope.workspaceId,
            agentId,
            requestedBy: context.get('user').id,
            instructions,
         });
         // 202, and the location of the thing that was created: the run is
         // durable, and what happens to it next is the ledger's business.
         //
         // Set on the response rather than through `context.header`, because
         // `json` builds its own Response and never sees the context's.
         const response = json(serializeRun(run), 202);
         response.headers.set('Location', `/api/v1/runs/${run.id}`);
         return response;
      } catch (error) {
         if (error instanceof ActiveRunExists) {
            // The id is given so a client can go to the run rather than guess
            // why its request was refused.
            throw new ApiError(409, 'ACTIVE_RUN_EXISTS', 'This task already has a run in progress.', {
               runId: error.runId,
            });
         }
         if (error instanceof NoAgentAssigned) {
            throw new ApiError(409, 'CONFLICT', 'This task has no agent assigned to run it.');
         }
         throw error;
      }
   });

   return route;
}

// ------------------------------------------------------------------ helpers

/** The wire shape, field for field as the contract declares it. */
export function serializeRun(run: Run): Record<string, unknown> {
   return {
      id: run.id,
      issueId: run.issueId,
      agentId: run.agentId,
      status: run.status,
      sequence: run.sequence,
      summary: run.summary,
      usage: {
         inputTokens: run.usage.inputTokens,
         outputTokens: run.usage.outputTokens,
         totalTokens: run.usage.totalTokens,
         costMicros: run.usage.costMicros,
         currency: run.usage.currency,
      },
      failure: run.failure
         ? { code: run.failure.code, message: run.failure.message, retryable: run.failure.retryable }
         : null,
      // Why this run exists, and who asked. Both are stored on the row and
      // were previously dropped here, which left an execution log unable to
      // tell an assignment apart from a mention or an autopilot.
      source: run.source,
      requestedBy: run.requestedBy ? { type: 'user', id: run.requestedBy } : null,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
   };
}

function connection(rows: Run[], first: number, scope: string): Record<string, unknown> {
   const hasNextPage = rows.length > first;
   const nodes = hasNextPage ? rows.slice(0, first) : rows;
   const last = nodes.at(-1);
   return {
      nodes: nodes.map(serializeRun),
      pageInfo: {
         hasNextPage,
         endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
      },
   };
}

function parseFilter(url: URL, allow: { agent?: boolean } = {}): RunFilter {
   const status = url.searchParams.get('status');
   if (status !== null && !STATUSES.has(status)) {
      assertValid([fieldError('/status', 'invalid_value', 'status is not a run status.')]);
   }
   const agentId = allow.agent === false ? null : url.searchParams.get('agentId');
   if (agentId !== null && !/^[0-9a-f-]{36}$/i.test(agentId)) {
      assertValid([fieldError('/agentId', 'invalid_value', 'agentId is not an identifier.')]);
   }
   return {
      ...(status === null ? {} : { status }),
      ...(agentId === null ? {} : { agentId }),
   };
}

/**
 * A cursor is only valid for the query that produced it.
 *
 * Paging with a filter and then changing it yields `INVALID_CURSOR` rather
 * than a page that silently skips rows.
 */
function filterScope(base: string, filter: RunFilter): string {
   return `${base}.${filter.status ?? 'all'}.${filter.agentId ?? 'any'}`;
}

function parseAfterSequence(after: string | null, lastEventId: string | undefined): number | null {
   const raw = after ?? lastEventId ?? null;
   if (raw === null || raw === '') return null;
   if (!/^\d+$/.test(raw)) {
      assertValid([fieldError('/after', 'invalid_value', 'after is an event sequence number.')]);
   }
   return Number(raw);
}

function optionalId(value: unknown): string | null {
   if (value === undefined || value === null) return null;
   if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
      assertValid([fieldError('/agentId', 'invalid_type', 'agentId names an agent by id.')]);
   }
   return value as string;
}

function optionalInstructions(value: unknown): string | null {
   if (value === undefined || value === null) return null;
   if (typeof value !== 'string') {
      assertValid([fieldError('/instructions', 'invalid_type', 'instructions is text.')]);
   }
   const text = (value as string).trim();
   if (text.length > MAX_INSTRUCTIONS) {
      assertValid([
         fieldError('/instructions', 'too_long', `instructions is at most ${MAX_INSTRUCTIONS} characters.`),
      ]);
   }
   return text === '' ? null : text;
}

async function resolveIssue(
   issues: IssueRepository,
   reference: string | undefined,
   userId: string,
   scope: 'product.read' | 'product.write'
) {
   const issue = await issues.get(reference ?? '').catch(() => {
      throw ApiError.notFound('Issue');
   });
   await issues.authorize(userId, issue.id, scope).catch(rethrow('Issue'));
   return issue;
}

function rethrow(resource: string) {
   return (error: unknown): never => {
      if (error instanceof NotFound || error instanceof Forbidden) throw ApiError.notFound(resource);
      throw error;
   };
}
