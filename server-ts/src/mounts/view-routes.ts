import { Hono } from 'hono';
import type { AuthVariables } from '../auth/middleware.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import { parseJsonBody } from '../work/http.ts';
import { issueQuerySchema, runIssueQuery } from '../work/issue-query.ts';
import {
   createView,
   deleteView,
   preferencesSchema,
   readPreferences,
   updateView,
   viewCreateSchema,
   viewPatchSchema,
   viewWorkspace,
   writePreferences,
} from '../work/views.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** Saved-view writes, preferences and the grouped query, under `/api/v1/views`. */
const MODERATOR_ROLES = new Set(['owner', 'admin']);

export function savedViewRoutes(options: { sql: Sql }): Hono<{ Variables: AuthVariables }> {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   const asView = rethrowWork('View');

   /** A view's workspace is read from the row, then membership is confirmed. */
   const scopeOfView = async (viewId: string, userId: string) => {
      const workspaceId = await viewWorkspace(sql, viewId);
      if (!workspaceId) throw ApiError.notFound('View');
      return resolveScoped(sql, userId, workspaceId).catch(() => {
         throw ApiError.notFound('View');
      });
   };

   route.get('/preferences', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, new URL(context.req.url).searchParams.get('workspaceId') ?? '');
      return json(await readPreferences(sql, db.ctx.workspaceId, userId));
   });

   route.put('/preferences', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, preferencesSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const written = await writePreferences(sql, db.ctx.workspaceId, userId, input).catch(asView);
      return json(written);
   });

   route.post('/query', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, issueQuerySchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      return json(await runIssueQuery(sql, db.ctx.workspaceId, input));
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, viewCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const view = await createView(sql, db.ctx.workspaceId, userId, input).catch((error: unknown) => {
         if ((error as { code?: string }).code === '23514') {
            throw new ApiError(422, 'VIEW_TOO_LARGE', 'The view definition is too large.');
         }
         throw error;
      });
      return json(view, 201);
   });

   route.patch('/:viewId', async (context) => {
      const userId = context.get('user').id;
      const viewId = pathId(context.req.param('viewId'), 'View');
      const db = await scopeOfView(viewId, userId);
      const patch = await parseJsonBody(context.req.raw, viewPatchSchema);
      const view = await sql
         .begin((tx) =>
            updateView(tx, { workspaceId: db.ctx.workspaceId, viewId, actorId: userId, moderator: MODERATOR_ROLES.has(db.ctx.role), patch })
         )
         .catch(asView);
      return json(view);
   });

   route.delete('/:viewId', async (context) => {
      const userId = context.get('user').id;
      const viewId = pathId(context.req.param('viewId'), 'View');
      const db = await scopeOfView(viewId, userId);
      await sql
         .begin((tx) => deleteView(tx, { workspaceId: db.ctx.workspaceId, viewId, actorId: userId, moderator: MODERATOR_ROLES.has(db.ctx.role) }))
         .catch(asView);
      return new Response(null, { status: 204 });
   });

   return route;
}
