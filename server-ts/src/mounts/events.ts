import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { goJSON } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import type { BoardRepository } from '../core/boards.ts';
import {
   BOARD_TOPICS,
   CursorExpired,
   WORKSPACE_TOPICS,
   type OutboxCursor,
   type ReplayEvent,
   type ReplayRepository,
} from '../realtime/replay.ts';

/**
 * `GET /api/v1/events`.
 *
 * One stream per board and one per workspace, and the split is not cosmetic:
 * a board stream carries what happens on that board, while a workspace stream
 * carries the facts that belong to no board at all — goals,
 * approvals, plans — plus the few issue and agent moments a workspace-wide
 * consumer has to notice.
 *
 * The stream replays from PostgreSQL and is *woken* by Valkey. That is the
 * whole design: a client disconnected for ten minutes gets the same answer as
 * one that never left, and losing the relay costs latency rather than facts —
 * the poll below still finds everything, just later.
 */

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const HEARTBEAT_MS = 10_000;
const POLL_MS = 500;
const REPLAY_BATCH = 200;
const MAX_CURSOR_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EventOptions {
   sessions: SessionService;
   replay: ReplayRepository;
   boards: BoardRepository;
   broadcaster?: Broadcaster | undefined;
   /** How far back a reconnecting client may resume from. */
   retentionMs?: number;
   heartbeatMs?: number;
   pollMs?: number;
   clock?: () => Date;
}

export function eventMounts(options: EventOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));

   const clock = options.clock ?? (() => new Date());
   const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
   const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
   const pollMs = options.pollMs ?? POLL_MS;

   route.get('/', async (context) => {
      const request = parseRequest(new URL(context.req.url), context.req.raw.headers);
      const userId = context.get('user').id;

      // Authorized before anything is streamed. A 200 with an event-stream
      // body cannot be taken back, so the refusal has to happen while a JSON
      // error is still possible.
      if (request.scope === 'workspace') {
         await options.boards
            .authorizeWorkspace(userId, request.scopeId, 'product.read')
            .catch(rethrow('workspace'));
      } else {
         await options.boards
            .authorize(userId, request.scopeId, 'product.read')
            .catch(rethrow('board'));
      }

      const topics = request.scope === 'workspace' ? WORKSPACE_TOPICS : BOARD_TOPICS;
      const column = request.scope === 'workspace' ? 'workspace_id' : 'board_id';
      const cutoff = new Date(clock().getTime() - retentionMs).toISOString();

      let after: OutboxCursor | null = null;
      if (request.cursor !== '') {
         if (!UUID.test(request.cursor)) throw cursorExpired();
         after = await options.replay
            .resolveCursor(column, request.scopeId, topics, request.cursor, cutoff)
            .catch((error: unknown) => {
               if (error instanceof CursorExpired) throw cursorExpired();
               throw error;
            });
      }

      // Subscribed before the backlog is read, so a fact that lands between
      // the two wakes the loop rather than waiting for the next poll.
      const subscription = options.broadcaster
         ? await options.broadcaster.subscribe(request.scopeId)
         : null;

      const stream = new ReadableStream<Uint8Array>({
         start: (controller) => {
            void pump({
               controller,
               replay: options.replay,
               column,
               scopeId: request.scopeId,
               scope: request.scope,
               topics,
               cutoff,
               after,
               subscription,
               signal: context.req.raw.signal,
               heartbeatMs,
               pollMs,
            });
         },
         cancel: () => subscription?.close(),
      });

      return new Response(stream, {
         status: 200,
         headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Nginx buffers a response body by default, which turns a live
            // stream into one long silence followed by everything at once.
            'X-Accel-Buffering': 'no',
         },
      });
   });

   return [{ prefix: '/api/v1/events', handler: route }];
}

interface PumpOptions {
   controller: ReadableStreamDefaultController<Uint8Array>;
   replay: ReplayRepository;
   column: 'board_id' | 'workspace_id';
   scopeId: string;
   scope: 'board' | 'workspace';
   topics: readonly string[];
   cutoff: string;
   after: OutboxCursor | null;
   subscription: { next(): Promise<unknown>; close(): void } | null;
   signal: AbortSignal;
   heartbeatMs: number;
   pollMs: number;
}

/**
 * Drains the backlog, then follows.
 *
 * Every wakeup — a relayed event, a poll tick, or nothing at all — leads to
 * the same thing: ask PostgreSQL what happened after the cursor. The relayed
 * event's *contents* are deliberately never written to the client; it is a
 * doorbell, and answering the door is a read.
 */
async function pump(options: PumpOptions): Promise<void> {
   const encoder = new TextEncoder();
   let after = options.after;
   let closed = false;

   const send = (text: string): boolean => {
      if (closed) return false;
      try {
         options.controller.enqueue(encoder.encode(text));
         return true;
      } catch {
         // The client hung up between the read and the write.
         closed = true;
         return false;
      }
   };

   const drain = async (): Promise<boolean> => {
      for (;;) {
         const found = await options.replay.replay(
            options.column, options.scopeId, options.topics, after, options.cutoff, REPLAY_BATCH);
         for (const event of found) {
            if (!send(frame(event, options.scope))) return false;
            after = { occurredAt: event.occurredAt, id: event.id };
         }
         // A short batch means the backlog is drained; a full one means there
         // is more behind it and stopping here would strand the rest until
         // something else happened.
         if (found.length < REPLAY_BATCH) return true;
      }
   };

   try {
      // Tells the browser's EventSource how long to wait before reconnecting.
      if (!send('retry: 3000\n\n')) return;
      if (!(await drain())) return;

      let lastSent = Date.now();
      while (!options.signal.aborted && !closed) {
         await Promise.race([
            options.subscription?.next() ?? never(),
            sleep(options.pollMs),
            aborted(options.signal),
         ]);
         if (options.signal.aborted || closed) break;

         const before = after;
         if (!(await drain())) break;
         if (after !== before) {
            lastSent = Date.now();
            continue;
         }
         // A comment frame, so a proxy that would otherwise close an idle
         // connection sees traffic and the client learns the stream is alive.
         if (Date.now() - lastSent >= options.heartbeatMs) {
            if (!send(': heartbeat\n\n')) break;
            lastSent = Date.now();
         }
      }
   } catch {
      // Any failure ends the stream. The client reconnects with its last id
      // and resumes exactly where it stopped, which is what the cursor is for.
   } finally {
      options.subscription?.close();
      if (!closed) {
         try {
            options.controller.close();
         } catch {
            // Already closed by the runtime when the socket went.
         }
      }
   }
}

/**
 * One SSE frame.
 *
 * `id` is the event's own id, which is what a reconnecting client sends back
 * as `Last-Event-ID`; `event` is the topic, so a listener can subscribe to one
 * kind without parsing every frame.
 */
function frame(event: ReplayEvent, scope: 'board' | 'workspace'): string {
   // The two streams differ in one way: a board stream knows its board and
   // issue, so those are plain values; a workspace stream carries facts that
   // belong to neither, so they are nullable there.
   const body =
      scope === 'workspace'
         ? {
              id: event.id,
              type: event.type,
              occurredAt: event.occurredAt,
              workspaceId: event.workspaceId,
              boardId: event.boardId,
              issueId: event.issueId,
              runId: event.runId,
              sequence: event.sequence,
              payload: event.payload,
           }
         : {
              id: event.id,
              type: event.type,
              occurredAt: event.occurredAt,
              workspaceId: event.workspaceId,
              boardId: event.boardId,
              issueId: event.issueId ?? NIL_UUID,
              runId: event.runId,
              sequence: event.sequence,
              payload: event.payload,
           };
   return `id: ${event.id}\nevent: ${event.type}\ndata: ${goJSON(body)}\n\n`;
}

/** A board frame's issueId is the nil uuid when the fact belongs to no issue. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

interface ParsedRequest {
   scope: 'board' | 'workspace';
   scopeId: string;
   cursor: string;
}

/** Exactly one of boardId or workspaceId, and at most one cursor. */
export function parseRequest(url: URL, headers: Headers): ParsedRequest {
   for (const name of url.searchParams.keys()) {
      if (!['boardId', 'workspaceId', 'after'].includes(name)) {
         throw invalid('Unknown query parameter.');
      }
      if (url.searchParams.getAll(name).length !== 1) {
         throw invalid('Query parameters must appear once.');
      }
   }
   const board = url.searchParams.get('boardId');
   const workspace = url.searchParams.get('workspaceId');
   if ((board === null) === (workspace === null)) {
      throw invalid('Provide exactly one of boardId or workspaceId.');
   }

   const scope = workspace !== null ? 'workspace' : 'board';
   const raw = (workspace ?? board)!;
   if (!UUID.test(raw) || raw === NIL_UUID) {
      // The two scopes report a bad id differently, and Go's wording is what
      // the frontend shows.
      throw scope === 'workspace'
         ? new ApiError(422, 'VALIDATION_FAILED', 'workspaceId must be a canonical UUID.', {
              fields: [{ path: '/query/workspaceId', code: 'invalid', message: 'workspaceId must be a canonical UUID.' }],
           })
         : new ApiError(422, 'VALIDATION_FAILED', 'boardId must be a canonical UUID.', {
              fields: [{ path: '/query/boardId', code: 'invalid', message: 'boardId must be a canonical UUID.' }],
           });
   }

   const lastEventHeaders = [...headers].filter(([name]) => name.toLowerCase() === 'last-event-id');
   if (lastEventHeaders.length > 1) throw invalid('Last-Event-ID must appear once.');
   const lastEventId = (lastEventHeaders[0]?.[1] ?? '').trim();
   const after = (url.searchParams.get('after') ?? '').trim();
   // Both would be a client asking to resume from two places at once, and
   // picking one silently is how a stream skips what the other named.
   if (lastEventId !== '' && after !== '') {
      throw invalid('Provide either the Last-Event-ID header or the after cursor, not both.');
   }
   const cursor = lastEventId !== '' ? lastEventId : after;
   if (Buffer.byteLength(cursor, 'utf8') > MAX_CURSOR_BYTES) {
      throw invalid('The event cursor is malformed.');
   }
   return { scope, scopeId: raw.toLowerCase(), cursor };
}

function invalid(message: string): ApiError {
   return new ApiError(400, 'INVALID_REQUEST', message);
}

/**
 * 409, not 410.
 *
 * A cursor outside the retention window is a conflict between what the client
 * remembers and what the server still holds, and the wording tells it what to
 * do about it — reconnect with nothing and reconcile from the resources
 * themselves, because the events that would have caught it up are gone.
 */
function cursorExpired(): ApiError {
   return new ApiError(
      409,
      'CURSOR_EXPIRED',
      'The event cursor is older than the retention window; reconnect without a cursor and reconcile from current resources.'
   );
}

function rethrow(scope: 'board' | 'workspace'): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof NotFound) {
         throw scope === 'workspace'
            ? new ApiError(404, 'NOT_FOUND', 'The requested workspace was not found.')
            : new ApiError(404, 'BOARD_NOT_FOUND', 'The requested board was not found.');
      }
      if (error instanceof Forbidden) {
         throw new ApiError(403, 'FORBIDDEN', `You do not have permission to stream this ${scope}.`);
      }
      throw error;
   };
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function never(): Promise<never> {
   return new Promise(() => {});
}

function aborted(signal: AbortSignal): Promise<void> {
   if (signal.aborted) return Promise.resolve();
   return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}
