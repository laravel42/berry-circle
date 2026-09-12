import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import { assertValid, decodeBody, fieldError } from '../http/body.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { InboxAction, InboxItem, InboxRepository, InboxState } from '../inbox/repository.ts';
import { pathId } from './shared.ts';

/**
 * `/api/v1/inbox`.
 *
 * A person's own notifications. Every route is scoped to the caller — there is
 * no route here that takes a recipient, because there is no such thing as
 * reading someone else's inbox, and an API that could express it would
 * eventually be asked to.
 *
 * The actions are POSTs rather than a PATCH with a body, because that is what
 * the shell already calls: `/inbox/{id}/read`, `/unread`, `/archive`,
 * `/unarchive`, and `/inbox/bulk` for a selection.
 */

const ACTIONS = new Set<InboxAction>(['read', 'unread', 'archive', 'unarchive']);
const STATES = new Set<InboxState>(['active', 'archived', 'all']);

/** One request cannot sweep an unbounded selection. */
const MAX_BULK = 200;

const FILTERS = ['workspaceId', 'state', 'unread'] as const;

export interface InboxOptions {
   sessions: SessionService;
   inbox: InboxRepository;
   boards: BoardRepository;
}

export function inboxMounts(options: InboxOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { inbox } = options;

   route.get('/', async (context) => {
      const url = new URL(context.req.url);
      const workspaceId = await requireWorkspace(context, options, url);

      const page = parsePageQuery(url, FILTERS);
      const state = (url.searchParams.get('state') ?? 'active') as InboxState;
      if (!STATES.has(state)) {
         assertValid([fieldError('/state', 'invalid_value', 'state is active, archived or all.')]);
      }
      const unreadOnly = url.searchParams.get('unread') === 'true';
      const scope = `inbox.${workspaceId}.${context.get('user').id}.${state}.${unreadOnly}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);

      const rows = await inbox.list({
         workspaceId,
         recipientId: context.get('user').id,
         state,
         unreadOnly,
         after,
         limit: page.first + 1,
      });
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes: nodes.map(serializeItem),
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { createdAt: last.createdAt, id: last.id }) : null,
         },
      });
   });

   /** The badge. Its own route because it is polled far more often than the list. */
   route.get('/unread-count', async (context) => {
      const url = new URL(context.req.url);
      const workspaceId = await requireWorkspace(context, options, url);
      return json({ count: await inbox.unreadCount(workspaceId, context.get('user').id) });
   });

   route.post('/bulk', async (context) => {
      const { value: body } = await decodeBody<{
         workspaceId?: string;
         itemIds?: unknown;
         action?: string;
      }>(context, { workspaceId: 'string', itemIds: 'raw', action: 'string' });

      const problems = [];
      if (!body.workspaceId) {
         problems.push(fieldError('/workspaceId', 'required', 'workspaceId is required.'));
      }
      const itemIds = Array.isArray(body.itemIds) ? body.itemIds : [];
      if (itemIds.length === 0) {
         problems.push(fieldError('/itemIds', 'required', 'itemIds names at least one item.'));
      }
      if (itemIds.length > MAX_BULK) {
         problems.push(fieldError('/itemIds', 'too_long', `itemIds is at most ${MAX_BULK} items.`));
      }
      if (!itemIds.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))) {
         problems.push(fieldError('/itemIds', 'invalid_value', 'itemIds are identifiers.'));
      }
      if (!body.action || !ACTIONS.has(body.action as InboxAction)) {
         problems.push(
            fieldError('/action', 'invalid_value', 'action is read, unread, archive or unarchive.')
         );
      }
      if (problems.length > 0) assertValid(problems);

      await authorizeWorkspace(context, options, body.workspaceId!);
      const changed = await inbox.apply({
         workspaceId: body.workspaceId!,
         recipientId: context.get('user').id,
         itemIds: itemIds as string[],
         action: body.action as InboxAction,
      });
      // How many were actually the caller's. Ids belonging to someone else
      // match nothing rather than being refused, which is both safe and
      // silent about whether they exist.
      return json({ changed });
   });

   route.post('/:itemId/:action', async (context) => {
      const action = context.req.param('action') ?? '';
      if (!ACTIONS.has(action as InboxAction)) throw ApiError.routeNotFound();
      const itemId = pathId(context.req.param('itemId'), 'Notification');

      const { value: body } = await decodeBody<{ workspaceId?: string }>(context, {
         workspaceId: 'string',
      });
      if (!body.workspaceId) {
         assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
      }
      await authorizeWorkspace(context, options, body.workspaceId!);

      const changed = await inbox.apply({
         workspaceId: body.workspaceId!,
         recipientId: context.get('user').id,
         itemIds: [itemId],
         action: action as InboxAction,
      });
      if (changed === 0) throw ApiError.notFound('Notification');
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/inbox', handler: route }];
}

// ------------------------------------------------------------------ helpers

function serializeItem(item: InboxItem): Record<string, unknown> {
   return {
      id: item.id,
      workspaceId: item.workspaceId,
      recipientId: item.recipientId,
      eventType: item.eventType,
      category: item.category,
      severity: item.severity,
      issueId: item.issueId,
      issueStatus: item.issueStatus,
      issueIdentifier: item.issueIdentifier,
      actorType: item.actorType,
      actorId: item.actorId,
      title: item.title,
      body: item.body,
      // The inbox page reads the recorded prompt and the comment a
      // notification is about out of here; anything else it does not
      // recognize it leaves alone.
      details: item.details,
      read: item.read,
      archived: item.archived,
      createdAt: item.createdAt,
      approvalId: item.approvalId,
      goalId: item.goalId,
      planId: item.planId,
   };
}

async function requireWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: InboxOptions,
   url: URL
): Promise<string> {
   const workspaceId = url.searchParams.get('workspaceId');
   if (!workspaceId) {
      assertValid([fieldError('/workspaceId', 'required', 'workspaceId is required.')]);
   }
   await authorizeWorkspace(context, options, workspaceId!);
   return workspaceId!;
}

async function authorizeWorkspace(
   context: { get: (key: 'user') => { id: string } },
   options: InboxOptions,
   workspaceId: string
): Promise<void> {
   // Membership, not a permission: an inbox is a person's own, so the only
   // question is whether they belong to the workspace at all.
   await options.boards
      .authorizeWorkspace(context.get('user').id, workspaceId, 'product.read')
      .catch((error: unknown) => {
         if (error instanceof NotFound || error instanceof Forbidden) {
            throw ApiError.notFound('Workspace');
         }
         throw error;
      });
}
