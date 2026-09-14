import { Hono } from 'hono';
import { z } from 'zod';
import type { BearerResolver } from '../auth/credentials.ts';
import { InvalidParent, type Comment, type CommentRepository } from '../core/comments.ts';
import {
   apiStatusToDb,
   dbStatusToApi,
   InvalidTransition,
   type Issue,
   type IssuePatch,
   type IssueRepository,
} from '../core/issues.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { readJson } from '../http/json-body.ts';
import type { Mount } from '../http/registry.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import type { Permission } from '../identity/roles.ts';
import { InvalidPluginInput } from '../plugins/errors.ts';
import { validStorageKey, type PluginRuntimeStore } from '../plugins/runtime-store.ts';
import {
   actorId,
   personalTokenScopes,
   requireApiCredential,
   requirePlugin,
   requireScope,
   type ApiPrincipal,
   type PublicApiVariables,
} from '../public-api/auth.ts';
import type { Broadcaster } from '../realtime/hub.ts';

/**
 * `/v1` — Berry's public API for programs and plugins.
 *
 * Deliberately small and separate from `/api/v1`: it has its own credential
 * rules (tokens only, with scopes) and its own response shapes, so the
 * product API can keep evolving with the frontend without breaking scripts.
 * Every issue read and write still goes through the same membership check as
 * the product API, as the token's owner — for a plugin, the member who
 * installed it.
 */

export interface PublicApiOptions {
   /** J's `personalTokenResolver(sql)`. */
   personalTokens: Pick<BearerResolver, 'resolve'>;
   sql: Sql;
   issues: IssueRepository;
   comments: CommentRepository;
   plugins: PluginRuntimeStore | null;
   broadcaster?: Broadcaster | undefined;
   clock?: () => Date;
}

const STATUSES = ['backlog', 'todo', 'inProgress', 'inReview', 'done', 'blocked', 'cancelled'] as const;
const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'] as const;

const patchSchema = z
   .object({
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(100_000).nullable().optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
   })
   .strict()
   .refine((value) => Object.keys(value).length > 0, 'Name at least one field to change.');

const commentSchema = z
   .object({
      body: z.string().trim().min(1).max(50_000),
      parentId: z.uuid().nullable().optional(),
   })
   .strict();

const storageSchema = z.object({ value: z.json() }).strict();

export function publicApiMounts(options: PublicApiOptions): Mount[] {
   return [{ prefix: '/v1', handler: publicApiRoutes(options) }];
}

function publicApiRoutes(options: PublicApiOptions): Hono<{ Variables: PublicApiVariables }> {
   const route = new Hono<{ Variables: PublicApiVariables }>();
   const clock = options.clock ?? (() => new Date());
   route.use(
      '*',
      requireApiCredential({
         personalTokens: options.personalTokens,
         plugins: options.plugins,
         personalScopes: personalTokenScopes(options.sql),
      })
   );

   route.get('/context', async (context) => {
      const principal = context.get('principal');
      if (principal.kind === 'user') {
         const workspaces = await options.sql`
            SELECT w.id, w.name, w.slug, m.role::text AS role
              FROM workspace_memberships AS m
              JOIN workspaces AS w ON w.id = m.workspace_id AND w.deleted_at IS NULL
             WHERE m.user_id = ${principal.user.id}
             ORDER BY w.created_at, w.id`;
         return json({
            principal: { type: 'user', id: principal.user.id, name: principal.user.name, email: principal.user.email },
            scopes: principal.scopes,
            workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.role })),
         });
      }
      const [workspace] = await options.sql`
         SELECT id, name, slug FROM workspaces WHERE id = ${principal.plugin.workspaceId}`;
      return json({
         principal: {
            type: 'plugin',
            installationId: principal.plugin.installationId,
            pluginKey: principal.plugin.pluginKey,
         },
         scopes: principal.scopes,
         workspaces: workspace ? [{ id: workspace.id, name: workspace.name, slug: workspace.slug, role: null }] : [],
      });
   });

   route.get('/issues/:ref', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'issues:read');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.read');
      return json(serializeIssue(issue));
   });

   route.patch('/issues/:ref', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'issues:write');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.write');
      const body = await readJson(context, patchSchema);
      const patch: IssuePatch = {
         descriptionSet: body.description !== undefined,
         dueDateSet: false,
         assigneeSet: false,
         projectSet: false,
         ...(body.title !== undefined ? { title: body.title } : {}),
         ...(body.description !== undefined ? { description: body.description } : {}),
         ...(body.status !== undefined ? { status: apiStatusToDb(body.status) } : {}),
         ...(body.priority !== undefined ? { priority: body.priority } : {}),
      };
      const result = await options.issues
         .update({ issueId: issue.id, patch, actorId: actorId(principal) })
         .catch((error: unknown) => {
            if (error instanceof InvalidTransition) {
               throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move from ${error.from} to ${error.to}.`);
            }
            return mapIssueError(error);
         });
      await publish(options.broadcaster, result.events);
      return json(serializeIssue(result.issue));
   });

   route.get('/issues/:ref/comments', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'comments:read');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'product.read');
      const first = Math.min(100, Math.max(1, Number(context.req.query('first') ?? '50') || 50));
      const found = await options.comments.list(issue.id, null, first);
      return json({ nodes: found.map(serializeComment) });
   });

   route.post('/issues/:ref/comments', async (context) => {
      const principal = context.get('principal');
      requireScope(principal, 'comments:write');
      const issue = await loadIssue(options, principal, context.req.param('ref'), 'comments.write');
      const body = await readJson(context, commentSchema);
      const created = await options.comments
         .create({
            issueId: issue.id,
            authorId: actorId(principal),
            body: body.body,
            parentId: body.parentId ?? null,
            createdAt: clock().toISOString(),
         })
         .catch((error: unknown) => {
            if (error instanceof InvalidParent) {
               throw new ApiError(422, 'INVALID_PARENT', 'A reply must hang off a top-level comment on this issue.');
            }
            return mapIssueError(error);
         });
      await publish(options.broadcaster, [created.event]);
      return json(serializeComment(created.comment), 201);
   });

   route.get('/storage', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:read');
      const store = requireStore(options.plugins);
      const first = Math.min(100, Math.max(1, Number(context.req.query('first') ?? '50') || 50));
      const found = await store.listValues(plugin.installationId, {
         prefix: context.req.query('prefix') ?? '',
         after: context.req.query('after') ?? null,
         limit: first + 1,
      });
      const nodes = found.slice(0, first);
      return json({
         nodes,
         pageInfo: { hasNextPage: found.length > first, endCursor: nodes.at(-1)?.key ?? null },
      });
   });

   route.get('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:read');
      const found = await requireStore(options.plugins).getValue(plugin.installationId, storageKey(context.req.param('key')));
      if (!found) throw ApiError.notFound('Storage key');
      return json(found);
   });

   route.put('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:write');
      const key = storageKey(context.req.param('key'));
      const body = await readJson(context, storageSchema, 100_000);
      try {
         return json(await requireStore(options.plugins).putValue(plugin, key, body.value));
      } catch (error) {
         if (error instanceof InvalidPluginInput) {
            throw new ApiError(422, 'VALIDATION_FAILED', error.fields[0]?.message ?? 'Invalid value.', { fields: error.fields });
         }
         throw error;
      }
   });

   route.delete('/storage/:key{.+}', async (context) => {
      const principal = context.get('principal');
      const plugin = requirePlugin(principal);
      requireScope(principal, 'storage:write');
      await requireStore(options.plugins).deleteValue(plugin.installationId, storageKey(context.req.param('key')));
      return new Response(null, { status: 204 });
   });

   return route;
}

async function loadIssue(
   options: PublicApiOptions,
   principal: ApiPrincipal,
   reference: string,
   permission: Permission
): Promise<Issue> {
   const issue = await options.issues.get(reference).catch(mapIssueError);
   // A plugin is bound to one workspace; outside it, an issue does not exist.
   if (principal.kind === 'plugin' && issue.workspaceId !== principal.plugin.workspaceId) {
      throw ApiError.notFound('Issue');
   }
   await options.issues.authorize(actorId(principal), issue.id, permission).catch(mapIssueError);
   return issue;
}

function mapIssueError(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Issue');
   if (error instanceof Forbidden) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
   }
   throw error;
}

function requireStore(store: PluginRuntimeStore | null): PluginRuntimeStore {
   if (!store) throw new ApiError(412, 'PLUGINS_NOT_CONFIGURED', 'Plugins are not available on this deployment.');
   return store;
}

function storageKey(raw: string): string {
   if (!validStorageKey(raw)) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Key must be 1 to 200 URL-safe characters.');
   }
   return raw;
}

async function publish(
   broadcaster: Broadcaster | undefined,
   events: { id: string; type: string; workspaceId: string; boardId: string; payload: string; occurredAt: Date }[]
): Promise<void> {
   if (!broadcaster) return;
   for (const event of events) {
      try {
         await broadcaster.publish({
            id: event.id,
            workspaceId: event.workspaceId,
            boardId: event.boardId,
            type: event.type,
            payload: event.payload,
            occurredAt: event.occurredAt,
         });
      } catch {
         // The outbox row is committed; the SSE replay delivers it on the next poll.
      }
   }
}

function serializeIssue(issue: Issue): Record<string, unknown> {
   return {
      id: issue.id,
      identifier: issue.identifier,
      workspaceId: issue.workspaceId,
      boardId: issue.boardId,
      title: issue.title,
      description: issue.description,
      status: dbStatusToApi(issue.status),
      priority: issue.priority,
      dueDate: issue.dueDate,
      assignee: issue.assignee ? { type: issue.assignee.type, id: issue.assignee.id, name: issue.assignee.name } : null,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
   };
}

function serializeComment(comment: Comment): Record<string, unknown> {
   return {
      id: comment.id,
      issueId: comment.issueId,
      parentId: comment.parentId,
      body: comment.body,
      author: { type: comment.author.type, id: comment.author.id, name: comment.author.name },
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
   };
}
