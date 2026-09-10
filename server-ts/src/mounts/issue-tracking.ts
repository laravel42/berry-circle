import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthVariables } from '../auth/middleware.ts';
import type { BoardRepository } from '../core/boards.ts';
import type { CommentRepository } from '../core/comments.ts';
import { apiStatusToDb, type Issue, type IssuePatch, type IssueRepository } from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { decodeTimeCursor, encodeCursor, parsePageQuery } from '../http/cursor.ts';
import { ApiError } from '../http/errors.ts';
import type { Permission } from '../identity/roles.ts';
import type { Broadcaster } from '../realtime/hub.ts';
import { autoDispatch } from '../runs/auto-dispatch.ts';
import type { RunRepository } from '../runs/repository.ts';
import { listIssueActivity } from '../work/activity.ts';
import {
   assigneeFrequency,
   batchDeleteSchema,
   batchUpdateSchema,
   childCreateSchema,
   defaultBoardId,
   moveSchema,
   parentSchema,
   quickCreateSchema,
   sortOrderBetween,
   sortOrderOf,
   statusChangeSchema,
   subscriptionSchema,
} from '../work/batch.ts';
import { childIssueIds, setParent, stageGate } from '../work/hierarchy.ts';
import type { WorkTrackingHooks } from '../work/hooks.ts';
import { failureCode, parseJsonBody } from '../work/http.ts';
import { metadataPatchSchema, patchMetadata, readMetadata } from '../work/metadata.ts';
import { publishEvents, recordIssueEvent, type WorkEvent } from '../work/outbox.ts';
import { clearValue, listValues, setValue } from '../work/properties.ts';
import { runQuickAction, type QuickActionEnqueue } from '../work/quick-actions.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from '../work/reactions.ts';
import { resolveStatus } from '../work/statuses.ts';
import { isSubscribed, listSubscribers, subscribe, subtreeIssueIds, unsubscribe } from '../work/subscribers.ts';
import { serializeIssue } from './issues.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * Work-tracking routes that hang under `/api/v1/issues`. Mounted by the issues
 * mount (the registry refuses a second mount on that prefix), before its own
 * `/:issueRef` routes, so `/assignee-frequency` is not read as an issue ref.
 */
export interface IssueTrackingOptions {
   sql: Sql;
   issues: IssueRepository;
   boards: BoardRepository;
   comments: CommentRepository;
   broadcaster?: Broadcaster | undefined;
   dispatch?: Pick<RunRepository, 'admit'> | undefined;
   enqueue?: QuickActionEnqueue | undefined;
   hooks?: WorkTrackingHooks | undefined;
}

const valueBody = z.object({ value: z.unknown() }).strict();
const emojiBody = z.object({ emoji: emojiSchema }).strict();
const NO_CHANGE: IssuePatch = { descriptionSet: false, dueDateSet: false, assigneeSet: false, projectSet: false };

export function issueTrackingRoutes(options: IssueTrackingOptions): Hono<{ Variables: AuthVariables }> {
   const { sql, issues } = options;
   const gate = stageGate(sql);
   const route = new Hono<{ Variables: AuthVariables }>();
   const asIssue = rethrowWork('Issue');

   const resolve = async (issueRef: string | undefined, userId: string, permission: Permission) => {
      const issue = await issues.get(issueRef ?? '').catch(asIssue);
      const scope = await issues.authorize(userId, issue.id, permission).catch(asIssue);
      return { issue, workspaceId: scope.workspaceId };
   };
   const serve = async (issue: Issue, status = 200) => {
      const relations = await issues.loadRelations([issue.id]);
      return json(serializeIssue(issue, relations.get(issue.id)), status);
   };
   const dispatchIfReady = async (issue: Issue, workspaceId: string, userId: string): Promise<Issue> => {
      if (!options.dispatch) return issue;
      const run = await autoDispatch(options.dispatch, issue, { workspaceId, requestedBy: userId }, gate);
      return run ? issues.get(issue.id) : issue;
   };
   const afterWrite = async (write: Parameters<WorkTrackingHooks['afterIssueWrite']>[0]) => {
      await options.hooks?.afterIssueWrite(write).catch(() => undefined);
   };
   const record = async (issueId: string, userId: string, type: string, payload: Record<string, unknown>) => {
      const event: WorkEvent = await recordIssueEvent(sql, { issueId, type, actor: { type: 'user', id: userId }, payload });
      await publishEvents(options.broadcaster, [event]);
   };
   /** Applies a patch the way PATCH /issues/:ref does, plus hooks and dispatch. */
   const applyPatch = async (issue: Issue, workspaceId: string, userId: string, patch: IssuePatch): Promise<Issue> => {
      const result = await issues.update({ issueId: issue.id, patch, actorId: userId });
      await publishEvents(options.broadcaster, result.events);
      await afterWrite({
         kind: 'updated',
         issue: result.issue,
         previousStatus: issue.status,
         previousAssigneeId: issue.assignee?.id ?? null,
         actorId: userId,
         workspaceId,
         eventIds: result.events.map((event) => event.id),
      });
      return dispatchIfReady(result.issue, workspaceId, userId);
   };
   /** Creates an issue on a board, optionally under a parent, then dispatches it. */
   const createOn = async (input: {
      boardId: string;
      workspaceId: string;
      userId: string;
      title: string;
      description: string | null;
      parentId: string | null;
      stage: number | null;
   }): Promise<Issue> => {
      const created = await issues
         .create({
            boardId: input.boardId,
            title: input.title,
            description: input.description,
            status: 'backlog',
            priority: 'none',
            sortOrder: 0,
            dueDate: null,
            assignee: null,
            project: null,
            createdBy: input.userId,
         })
         .catch(rethrowWork('Board'));
      await publishEvents(options.broadcaster, created.events);
      if (input.parentId) {
         await setParent(sql, { workspaceId: input.workspaceId, issueId: created.issue.id, parentId: input.parentId, stage: input.stage }).catch(asIssue);
      }
      const issue = await issues.get(created.issue.id);
      await afterWrite({
         kind: 'created',
         issue,
         previousStatus: null,
         previousAssigneeId: null,
         actorId: input.userId,
         workspaceId: input.workspaceId,
         eventIds: created.events.map((event) => event.id),
      });
      return issue;
   };

   // ------------------------------------------------------------ collection
   route.get('/assignee-frequency', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, new URL(context.req.url).searchParams.get('workspaceId') ?? '');
      return json({ nodes: await assigneeFrequency(sql, db.ctx.workspaceId, userId) });
   });

   route.post('/quick', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, quickCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId, 'product.write');
      const boardId = input.boardId ?? (await defaultBoardId(sql, db.ctx.workspaceId).catch(rethrowWork('Board')));
      const scope = await options.boards.authorize(userId, boardId, 'product.write').catch(rethrowWork('Board'));
      if (scope.workspaceId !== db.ctx.workspaceId) throw ApiError.notFound('Board');
      const issue = await createOn({
         boardId,
         workspaceId: db.ctx.workspaceId,
         userId,
         title: input.title,
         description: null,
         parentId: input.parentId ?? null,
         stage: input.stage ?? null,
      });
      return serve(issue, 201);
   });

   route.post('/batch', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, batchUpdateSchema);
      const updated: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      for (const issueId of input.issueIds) {
         try {
            const { issue, workspaceId } = await resolve(issueId, userId, 'product.write');
            const patch: IssuePatch = { ...NO_CHANGE };
            if (input.patch.priority) patch.priority = input.patch.priority;
            if (input.patch.status) patch.status = apiStatusToDb(input.patch.status);
            if (input.patch.statusId) {
               const status = await resolveStatus(sql, workspaceId, input.patch.statusId);
               patch.status = status.category;
               patch.statusId = status.id;
            }
            if (input.patch.assignee !== undefined) {
               patch.assigneeSet = true;
               patch.assignee = input.patch.assignee;
               if (
                  input.patch.assignee &&
                  !(await issues.assigneeExistsInWorkspace(workspaceId, input.patch.assignee.type, input.patch.assignee.id))
               ) {
                  throw ApiError.notFound('Assignee');
               }
            }
            await applyPatch(issue, workspaceId, userId, patch);
            updated.push(issue.id);
         } catch (error) {
            failed.push({ id: issueId, code: failureCode(error) });
         }
      }
      return json({ updated, failed });
   });

   route.post('/batch-delete', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, batchDeleteSchema);
      const deleted: string[] = [];
      const failed: Array<{ id: string; code: string }> = [];
      for (const issueId of input.issueIds) {
         try {
            const { issue } = await resolve(issueId, userId, 'product.write');
            const removed = await issues.remove({ issueId: issue.id, deletedBy: userId });
            await publishEvents(options.broadcaster, removed.events);
            deleted.push(issue.id);
         } catch (error) {
            failed.push({ id: issueId, code: failureCode(error) });
         }
      }
      return json({ deleted, failed });
   });

   // ------------------------------------------------------------ properties
   route.get('/:issueRef/properties', async (context) => {
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      return json({ nodes: await listValues(sql, workspaceId, issue.id) });
   });

   route.put('/:issueRef/properties/:propertyId', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      const body = await parseJsonBody(context.req.raw, valueBody);
      const written = await setValue(sql, { workspaceId, issueId: issue.id, propertyId, value: body.value, actorId: userId }).catch(rethrowWork('Property'));
      await record(issue.id, userId, 'issue.properties.changed', { propertyId, value: written.value });
      return json(written);
   });

   route.delete('/:issueRef/properties/:propertyId', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const propertyId = pathId(context.req.param('propertyId'), 'Property');
      if (await clearValue(sql, workspaceId, issue.id, propertyId)) {
         await record(issue.id, userId, 'issue.properties.changed', { propertyId, value: null });
      }
      return new Response(null, { status: 204 });
   });

   // -------------------------------------------------------------- metadata
   route.get('/:issueRef/metadata', async (context) => {
      const { issue } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      return json({ metadata: await readMetadata(sql, issue.id) });
   });

   route.patch('/:issueRef/metadata', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const patch = await parseJsonBody(context.req.raw, metadataPatchSchema);
      const metadata = await sql.begin((tx) => patchMetadata(tx, issue.id, patch)).catch(asIssue);
      await record(issue.id, userId, 'issue.metadata.changed', { keys: [...Object.keys(patch.set ?? {}), ...(patch.remove ?? [])] });
      return json({ metadata });
   });

   // ------------------------------------------------------------- reactions
   route.get('/:issueRef/reactions', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   route.post('/:issueRef/reactions', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'comments.write');
      const { emoji } = await parseJsonBody(context.req.raw, emojiBody);
      if (await addReaction(sql, 'issue', issue.id, userId, emoji)) {
         await record(issue.id, userId, 'issue.reactions.changed', { emoji, added: true });
      }
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   route.delete('/:issueRef/reactions/:emoji', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'comments.write');
      const emoji = emojiSchema.safeParse(context.req.param('emoji') ?? '');
      if (!emoji.success) throw ApiError.notFound('Reaction');
      if (await removeReaction(sql, 'issue', issue.id, userId, emoji.data)) {
         await record(issue.id, userId, 'issue.reactions.changed', { emoji: emoji.data, added: false });
      }
      return json({ nodes: await listReactions(sql, 'issue', issue.id, userId) });
   });

   // ----------------------------------------------------------- subscribers
   route.get('/:issueRef/subscribers', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      return json({ nodes: await listSubscribers(sql, issue.id), subscribed: await isSubscribed(sql, issue.id, userId) });
   });

   route.put('/:issueRef/subscription', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      const { subtree } = await parseJsonBody(context.req.raw, subscriptionSchema);
      const issueIds = subtree ? await subtreeIssueIds(sql, issue.id) : [issue.id];
      const count = await subscribe(sql, { workspaceId, issueIds, userIds: [userId], reason: 'manual' });
      await record(issue.id, userId, 'issue.subscribers.changed', { userId, subscribed: true, subtree });
      return json({ subscribed: true, count });
   });

   route.delete('/:issueRef/subscription', async (context) => {
      const userId = context.get('user').id;
      const { issue } = await resolve(context.req.param('issueRef'), userId, 'product.read');
      const subtree = new URL(context.req.url).searchParams.get('subtree') === 'true';
      const issueIds = subtree ? await subtreeIssueIds(sql, issue.id) : [issue.id];
      const count = await unsubscribe(sql, { issueIds, userId });
      await record(issue.id, userId, 'issue.subscribers.changed', { userId, subscribed: false, subtree });
      return json({ subscribed: false, count });
   });

   // ------------------------------------------------------------- hierarchy
   route.get('/:issueRef/children', async (context) => {
      const { issue } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      const ids = await childIssueIds(sql, issue.id);
      const children = await Promise.all(ids.map((id) => issues.get(id)));
      const relations = await issues.loadRelations(ids);
      return json({
         nodes: children.map((child) => serializeIssue(child, relations.get(child.id))),
         progress: issue.childProgress,
      });
   });

   route.post('/:issueRef/children', async (context) => {
      const userId = context.get('user').id;
      const { issue: parent, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, childCreateSchema);
      let title = input.title ?? '';
      let description: string | null = null;
      if (input.fromCommentId) {
         const comment = await options.comments.get(input.fromCommentId).catch(rethrowWork('Comment'));
         // A comment on another issue is not found, rather than quietly used.
         if (comment.issueId !== parent.id) throw ApiError.notFound('Comment');
         const firstLine = comment.body.split('\n').find((line) => line.trim() !== '') ?? 'Sub-task';
         title = input.title ?? [...firstLine.trim()].slice(0, 500).join('');
         description = comment.body;
      }
      const child = await createOn({
         boardId: parent.boardId,
         workspaceId,
         userId,
         title,
         description,
         parentId: parent.id,
         stage: input.stage ?? null,
      });
      await record(parent.id, userId, 'issue.hierarchy.changed', { childId: child.id, fromCommentId: input.fromCommentId ?? null });
      return serve(await dispatchIfReady(child, workspaceId, userId), 201);
   });

   route.put('/:issueRef/parent', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, parentSchema);
      await setParent(sql, { workspaceId, issueId: issue.id, parentId: input.parentId, stage: input.stage ?? null }).catch(asIssue);
      await record(issue.id, userId, 'issue.hierarchy.changed', { parentId: input.parentId, stage: input.stage ?? null });
      return serve(await dispatchIfReady(await issues.get(issue.id), workspaceId, userId));
   });

   route.put('/:issueRef/status', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const { statusId } = await parseJsonBody(context.req.raw, statusChangeSchema);
      const status = await resolveStatus(sql, workspaceId, statusId).catch(rethrowWork('Status'));
      const updated = await applyPatch(issue, workspaceId, userId, { ...NO_CHANGE, status: status.category, statusId: status.id }).catch(asIssue);
      return serve(updated);
   });

   route.post('/:issueRef/move', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'product.write');
      const input = await parseJsonBody(context.req.raw, moveSchema);
      const before = input.beforeId ? await sortOrderOf(sql, input.beforeId).catch(asIssue) : undefined;
      const after = input.afterId ? await sortOrderOf(sql, input.afterId).catch(asIssue) : undefined;
      const updated = await applyPatch(issue, workspaceId, userId, { ...NO_CHANGE, sortOrder: sortOrderBetween(before, after) }).catch(asIssue);
      return serve(updated);
   });

   // -------------------------------------------------------------- timeline
   route.get('/:issueRef/activity', async (context) => {
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), context.get('user').id, 'product.read');
      const page = parsePageQuery(new URL(context.req.url));
      const scope = `activity.${issue.id}`;
      const after = page.after === '' ? null : decodeTimeCursor(page.after, scope);
      const rows = await listIssueActivity(sql, { workspaceId, issueId: issue.id, after, limit: page.first + 1 });
      const hasNextPage = rows.length > page.first;
      const nodes = hasNextPage ? rows.slice(0, page.first) : rows;
      const last = nodes.at(-1);
      return json({
         nodes,
         pageInfo: {
            hasNextPage,
            endCursor: last ? encodeCursor(scope, { createdAt: last.occurredAt, id: last.id }) : null,
         },
      });
   });

   // ---------------------------------------------------------- quick actions
   route.post('/:issueRef/quick-actions/:actionId/run', async (context) => {
      const userId = context.get('user').id;
      const { issue, workspaceId } = await resolve(context.req.param('issueRef'), userId, 'runs.dispatch');
      const actionId = pathId(context.req.param('actionId'), 'Quick action');
      if (!options.enqueue) {
         throw new ApiError(503, 'QUICK_ACTIONS_UNAVAILABLE', 'Quick actions need the agent runtime, which this server does not have.');
      }
      const { runId } = await runQuickAction(sql, options.enqueue, {
         workspaceId,
         actionId,
         viewerId: userId,
         issue: { id: issue.id, identifier: issue.identifier, title: issue.title, description: issue.description },
      }).catch(rethrowWork('Quick action'));
      return json({ runId }, 202);
   });

   return route;
}
