import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { parseJsonBody } from '../work/http.ts';
import { listPins, pin, pinCreateSchema, pinOrderSchema, reorderPins, unpin } from '../work/pins.ts';
import { pathId, resolveScoped } from './shared.ts';
import { rethrowWork } from './work-errors.ts';

/** A person's sidebar pins: `/api/v1/pins`, workspace named by parameter. */
export function pinMounts(options: { sessions: SessionService; sql: Sql }): Mount[] {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const workspaceParam = (raw: string) => new URL(raw).searchParams.get('workspaceId') ?? '';

   route.get('/', async (context) => {
      const userId = context.get('user').id;
      const db = await resolveScoped(sql, userId, workspaceParam(context.req.url));
      return json({ nodes: await listPins(sql, db.ctx.workspaceId, userId) });
   });

   route.post('/', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, pinCreateSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const created = await sql
         .begin((tx) => pin(tx, db.ctx.workspaceId, userId, input.targetType, input.targetId))
         .catch(rethrowWork('Pin target'));
      return json(created, 201);
   });

   route.put('/order', async (context) => {
      const userId = context.get('user').id;
      const input = await parseJsonBody(context.req.raw, pinOrderSchema);
      const db = await resolveScoped(sql, userId, input.workspaceId);
      const nodes = await sql.begin((tx) => reorderPins(tx, db.ctx.workspaceId, userId, input.ids));
      return json({ nodes });
   });

   route.delete('/:pinId', async (context) => {
      const userId = context.get('user').id;
      const pinId = pathId(context.req.param('pinId'), 'Pin');
      const db = await resolveScoped(sql, userId, workspaceParam(context.req.url));
      if (!(await unpin(sql, db.ctx.workspaceId, userId, pinId))) throw ApiError.notFound('Pin');
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/pins', handler: route }];
}
