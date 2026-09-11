import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import { SealingUnavailable } from '../integrations/sealing.ts';
import type { McpServerRepository } from '../mcp/repository.ts';
import { mcpTransportSchema } from '../runtime/envelope.ts';
import { currentWorkspace, owned, pathId, resolveScoped, resolveScopedResource } from './shared.ts';
import { readJson } from './zod-body.ts';

const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const inputSchema = z.strictObject({
   agentId: z.string().uuid().nullable().default(null),
   name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
   url: z.string().url().max(2000).refine((u) => /^https?:\/\//.test(u), 'url must be http(s)'),
   transport: mcpTransportSchema.default('streamable_http'),
   headers: z.record(z.string().regex(HEADER), z.string().max(4000)).default({}),
   viaGateway: z.boolean().default(false),
   enabled: z.boolean().default(true),
});
const patchSchema = inputSchema.omit({ agentId: true }).partial();

export function mcpServerMounts(options: { sessions: SessionService; sql: Sql; servers: McpServerRepository }): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { servers, sql } = options;
   const scope = (user: { id: string; currentWorkspaceId: string | null }, write: boolean) =>
      resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), write ? 'settings.write' : 'product.read');
   // A server named by id is found in this workspace before `settings.write`
   // is checked: absent or foreign is the same 404 for every role.
   const scopeOne = (user: { id: string; currentWorkspaceId: string | null }, id: string) =>
      resolveScopedResource(
         sql,
         user.id,
         currentWorkspace(user.currentWorkspaceId),
         'settings.write',
         owned('mcp_servers', id, 'MCP server')
      );

   route.get('/', async (context) => {
      const scoped = await scope(context.get('user'), false);
      const raw = new URL(context.req.url).searchParams.get('agentId') ?? 'all';
      const filter = raw === 'all' ? 'all' : raw === 'workspace' ? null : pathId(raw, 'Agent');
      return json({ nodes: await servers.list(scoped.ctx.workspaceId, filter) });
   });

   route.post('/', async (context) => {
      const scoped = await scope(context.get('user'), true);
      const input = await readJson(context, inputSchema);
      const created = await servers.create(scoped.ctx.workspaceId, input, context.get('user').id).catch(rethrow);
      return json(created, 201);
   });

   route.patch('/:id', async (context) => {
      const id = pathId(context.req.param('id'), 'MCP server');
      const scoped = await scopeOne(context.get('user'), id);
      const patch = await readJson(context, patchSchema);
      const updated = await servers.update(scoped.ctx.workspaceId, id, patch).catch(rethrow);
      return json(updated);
   });

   route.delete('/:id', async (context) => {
      const id = pathId(context.req.param('id'), 'MCP server');
      const scoped = await scopeOne(context.get('user'), id);
      await servers.remove(scoped.ctx.workspaceId, id).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/mcp-servers', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('MCP server');
   if (error instanceof Conflict) throw new ApiError(409, 'MCP_SERVER_NAME_TAKEN', 'An MCP server with that name already exists.');
   if (error instanceof SealingUnavailable) {
      throw new ApiError(412, 'INTEGRATIONS_NOT_CONFIGURED', 'This server cannot store credentials.');
   }
   throw error;
}
