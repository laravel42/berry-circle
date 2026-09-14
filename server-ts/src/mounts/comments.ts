import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { ApiError, type FieldError } from '../http/errors.ts';
import { decodeTimeCursor, encodeCursor } from '../http/cursor.ts';
import { assertValid, fieldError } from '../http/body.ts';
import { idempotent } from '../http/idempotent.ts';
import type { IdempotencyStore } from '../http/idempotency.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Mount } from '../http/registry.ts';
import type { IssueRepository } from '../core/issues.ts';
import type { WorkTrackingHooks } from '../work/hooks.ts';
import type { CommentTriggers } from '../agents/triggers.ts';
import {
   InvalidParent,
   RevisionConflict,
   serializeComment,
   type CommentEvent,
   type CommentRepository,
} from '../core/comments.ts';

/**
 * Comments.
 *
 * Two mounts, as in Go. The collection hangs under an issue, because a comment
 * only means anything against the thing it is about; a single comment is
 * reachable directly by id, because a link to a comment has to survive without
 * knowing which issue it belongs to.
 */

const MAX_BODY_CHARACTERS = 100_000;
const MAX_BODY_BYTES = 1 << 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface CommentOptions {
   sessions: SessionService;
   comments: CommentRepository;
   issues: IssueRepository;
   idempotency: IdempotencyStore;
   broadcaster?: Broadcaster | undefined;
   clock?: () => Date;
   /** Extra `/api/v1/comments/:id/...` routes (reactions, resolution). */
   extensions?: Hono<{ Variables: AuthVariables }> | undefined;
   /** Subscriptions and inbox rows after a comment is written. */
   hooks?: Pick<WorkTrackingHooks, 'afterCommentCreate'> | undefined;
   /** Mentions and replies that start agent runs. Absent: a comment starts nothing. */
   triggers?: CommentTriggers | undefined;
}

export function commentMounts(options: CommentOptions): Mount[] {
   const { comments, issues } = options;
   const clock = options.clock ?? (() => new Date());

   const direct = new Hono<{ Variables: AuthVariables }>();
   direct.use('*', requireSession(options.sessions));
   if (options.extensions) direct.route('/', options.extensions);

   direct.get('/:commentId', async (context) => {
      const commentId = pathId(context.req.param('commentId'));
      await comments.authorize(context.get('user').id, commentId, 'product.read').catch(rethrow);
      const comment = await comments.get(commentId).catch(rethrow);
      return json(serializeComment(comment));
   });

   direct.patch('/:commentId', async (context) => {
      const commentId = pathId(context.req.param('commentId'));
      const scope = await comments
         .authorize(context.get('user').id, commentId, 'comments.write')
         .catch(rethrow);

      const body = await readBody(context.req.raw, ['body', 'revision']);
      const text = requireBody(body.body);
      const revision = parseRevision(body.revision);

      // Checked here as well as in the repository, because the two answers
      // differ: this is "you may not edit somebody else's comment", while the
      // repository's is the same check made again under the row lock so it
      // cannot straddle another edit.
      const moderator = scope.role === 'owner' || scope.role === 'admin';
      const existing = await comments.get(commentId).catch(rethrow);
      if (!moderator && (existing.author.type !== 'user' || existing.author.id !== context.get('user').id)) {
         throw forbiddenTo('edit');
      }

      const result = await comments
         .update({
            commentId,
            actorId: context.get('user').id,
            moderator,
            body: text,
            ...(revision === undefined ? {} : { expectedRevision: revision }),
            updatedAt: clock().toISOString(),
         })
         .catch(rethrowMutation('edit'));
      await publish(options, [result.event]);
      return json(serializeComment(result.comment));
   });

   direct.delete('/:commentId', async (context) => {
      const commentId = pathId(context.req.param('commentId'));
      const scope = await comments
         .authorize(context.get('user').id, commentId, 'comments.write')
         .catch(rethrow);
      const event = await comments
         .delete({
            commentId,
            actorId: context.get('user').id,
            moderator: scope.role === 'owner' || scope.role === 'admin',
            deletedAt: clock().toISOString(),
         })
         .catch(rethrowMutation('delete'));
      await publish(options, [event]);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/comments', handler: direct }];
}

/**
 * The comment routes that hang under an issue.
 *
 * Returned as a router for the issues mount to own rather than as a second
 * mount on `/api/v1/issues`: the registry enforces disjoint prefixes, and two
 * mounts claiming that one is exactly the ambiguity it exists to refuse. Go
 * splits it the same way, for the same reason.
 */
export function issueCommentRoutes(options: CommentOptions) {
   const { comments, issues } = options;
   const clock = options.clock ?? (() => new Date());

   const nested = new Hono<{ Variables: AuthVariables }>();

   nested.get('/:issueRef/comments', async (context) => {
      // Resolved before authorization because the reference may be an
      // identifier, and the issue's own id is what the check needs.
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrowIssue);
      await issues.authorize(context.get('user').id, issue.id, 'product.read').catch(rethrowIssue);

      const page = parsePage(new URL(context.req.url));
      const scope = commentCursorScope(issue.id);
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await comments.list(issue.id, after, page.first + 1);
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeComment),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   /**
    * Which agents a comment would start, before it is sent.
    *
    * Registered before the collection POST so `trigger-preview` is never read
    * as part of an issue reference. It writes nothing.
    */
   nested.post('/:issueRef/comments/trigger-preview', async (context) => {
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrowIssue);
      const scope = await issues
         .authorize(context.get('user').id, issue.id, 'comments.write')
         .catch(rethrowIssue);
      const body = await readBody(context.req.raw, ['body']);
      const text = requireBody(body.body);
      if (!options.triggers) return json({ targets: [], refused: [] });
      return json(
         await options.triggers.preview({
            workspaceId: scope.workspaceId,
            issueId: issue.id,
            authorId: context.get('user').id,
            body: text,
         })
      );
   });

   nested.post('/:issueRef/comments', idempotent(options.idempotency), async (context) => {
      const issue = await issues.get(context.req.param('issueRef') ?? '').catch(rethrowIssue);
      const scope = await issues
         .authorize(context.get('user').id, issue.id, 'comments.write')
         .catch(rethrowIssue);

      const body = await readBody(context.req.raw, ['body', 'parentId']);
      const text = requireBody(body.body);
      const parentId = parseParent(body.parentId);

      const result = await comments
         .create({
            issueId: issue.id,
            authorType: 'user',
            authorId: context.get('user').id,
            body: text,
            ...(parentId === undefined ? {} : { parentId }),
            createdAt: clock().toISOString(),
         })
         .catch(rethrowCreate);
      await publish(options, [result.event]);
      await options.hooks
         ?.afterCommentCreate({
            comment: result.comment,
            workspaceId: result.event.workspaceId,
            eventId: result.event.id,
            actorId: context.get('user').id,
         })
         .catch(() => undefined);
      // Only a person's comment reaches here (authorType is 'user'), so an
      // agent's result comment can never start another run.
      if (options.triggers) {
         await options.triggers.fire({
            workspaceId: scope.workspaceId,
            issueId: issue.id,
            authorId: context.get('user').id,
            commentId: result.comment.id,
            body: text,
         });
      }

      const response = json(serializeComment(result.comment), 201);
      response.headers.set('Location', `/api/v1/comments/${result.comment.id}`);
      return response;
   });

   return nested;
}

/**
 * The cursor's scope: `comments.list.` and the first eight bytes of the
 * issue id's SHA-256.
 *
 * Hashed rather than plain, and unchanged from the shape clients already
 * hold: a cursor handed out before this server existed must still decode, so
 * the scope has to be derived from the issue the same way it always was.
 */
export function commentCursorScope(issueId: string): string {
   return `comments.list.${createHash('sha256').update(issueId).digest('hex').slice(0, 16)}`;
}

function pathId(raw: string | undefined): string {
   if (!raw || !UUID.test(raw)) throw ApiError.notFound('Comment');
   return raw.toLowerCase();
}

function parsePage(url: URL): { first: number; after: string } {
   for (const name of url.searchParams.keys()) {
      if (!['first', 'after'].includes(name) || url.searchParams.getAll(name).length !== 1) {
         throw ApiError.badRequest('The request query is invalid.');
      }
   }
   let first = 50;
   const raw = url.searchParams.get('first') ?? '';
   if (raw !== '') {
      first = Number(raw);
      if (!Number.isInteger(first) || first < 1 || first > 100) {
         throw new ApiError(400, 'INVALID_REQUEST', 'The request query is invalid.', {
            fields: [
               { path: '/query/first', code: 'invalid', message: 'first must be an integer from 1 to 100.' },
            ],
         });
      }
   }
   const after = url.searchParams.get('after');
   // An `after=` with nothing after it is a cursor the caller meant to send
   // and did not, which is a different mistake from not paginating at all.
   if (after !== null && after === '') {
      throw new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid.');
   }
   return { first, after: after ?? '' };
}

async function readBody(request: Request, allowed: string[]): Promise<Record<string, unknown>> {
   const raw = await request.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
   }
   let parsed: unknown;
   try {
      parsed = JSON.parse(raw);
   } catch {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'The request body is not valid JSON.');
   }
   for (const key of Object.keys(parsed)) {
      if (!allowed.includes(key)) {
         assertValid([
            fieldError('/', 'invalid_type', 'The request body contains an unknown field or invalid value.'),
         ]);
      }
   }
   return parsed as Record<string, unknown>;
}

/**
 * A body is required, and counted in characters.
 *
 * Characters rather than bytes because that is what the column's CHECK counts:
 * a byte bound would refuse a comment of emoji the database would accept.
 */
function requireBody(value: unknown): string {
   const fields: FieldError[] = [];
   if (value === undefined || value === null) {
      fields.push(fieldError('/body', 'invalid_type', 'Field is required.'));
   } else if (typeof value !== 'string') {
      fields.push(fieldError('/body', 'invalid_type', 'Field is required.'));
   } else {
      const length = [...value].length;
      if (length < 1) {
         fields.push(fieldError('/body', 'too_small', 'Body must contain at least 1 character.'));
      }
      if (length > MAX_BODY_CHARACTERS) {
         fields.push(
            fieldError('/body', 'too_big', `Body must contain at most ${MAX_BODY_CHARACTERS} characters.`)
         );
      }
   }
   if (fields.length > 0) assertValid(fields);
   return value as string;
}

function parseRevision(value: unknown): number | undefined {
   if (value === undefined || value === null) return undefined;
   if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      assertValid([fieldError('/revision', 'too_small', 'revision must be a positive integer.')]);
   }
   return value as number;
}

function parseParent(value: unknown): string | undefined {
   if (value === undefined || value === null) return undefined;
   if (typeof value !== 'string' || !UUID.test(value)) {
      assertValid([fieldError('/parentId', 'invalid_string', 'parentId must be a UUID.')]);
   }
   return (value as string).toLowerCase();
}

function forbiddenTo(verb: string): ApiError {
   return new ApiError(403, 'FORBIDDEN', `You do not have permission to ${verb} this comment.`);
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Comment');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

function rethrowIssue(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Issue');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

/**
 * A missing parent and a parent on another issue are the same answer.
 *
 * Distinguishing them would tell a caller that a comment id exists somewhere
 * they cannot see.
 */
function rethrowCreate(error: unknown): never {
   if (error instanceof InvalidParent) {
      assertValid([
         fieldError('/parentId', 'invalid_parent', 'A reply cannot be nested under another reply.'),
      ]);
   }
   if (error instanceof NotFound) throw ApiError.notFound('Parent comment');
   throw rethrowIssue(error);
}

function rethrowMutation(verb: string): (error: unknown) => never {
   return (error: unknown) => {
      if (error instanceof RevisionConflict) {
         throw new ApiError(409, 'REVISION_CONFLICT', 'The comment changed since it was last read.', {
            currentRevision: error.currentRevision,
         });
      }
      if (error instanceof Forbidden) throw forbiddenTo(verb);
      if (error instanceof NotFound) throw ApiError.notFound('Comment');
      throw error;
   };
}

/**
 * Best effort, as everywhere else: the event is already in the outbox inside
 * the transaction that made it, so a relay outage costs open issues their live
 * update rather than the write.
 */
async function publish(options: CommentOptions, events: CommentEvent[]): Promise<void> {
   if (!options.broadcaster) return;
   for (const event of events) {
      await options.broadcaster
         .publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         })
         .catch(() => undefined);
   }
}
