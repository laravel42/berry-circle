import { Hono } from 'hono';
import { z } from 'zod';
import { BuilderMcpForbidden, BuilderUnavailable, type AgentBuilder } from '../agents/builder.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { Conflict, NotFound } from '../identity/errors.ts';
import { currentWorkspace, pathId, resolveScoped, resolveScopedResource } from './shared.ts';
import { readJson } from './zod-body.ts';

/**
 * `/api/v1/agent-builder`: draft an agent in conversation, then apply it.
 *
 * Every route is scoped to the caller's current workspace; a session of
 * another workspace is simply not found.
 */

const turnSchema = z.strictObject({ prompt: z.string().trim().min(1).max(4000) });
const applySchema = z.strictObject({ draftId: z.string().uuid() });

export function agentBuilderMounts(options: {
   sessions: SessionService;
   sql: Sql;
   builder: AgentBuilder;
}): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();
   route.use('*', requireSession(options.sessions));
   const { builder, sql } = options;
   const scope = async (user: { id: string; currentWorkspaceId: string | null }): Promise<string> =>
      (await resolveScoped(sql, user.id, currentWorkspace(user.currentWorkspaceId), 'product.write')).ctx
         .workspaceId;
   const sessionId = (raw: string | undefined): string => pathId(raw, 'Builder session');
   /**
    * The scope for one session. The session is found in the caller's
    * workspace before `product.write` is checked, so an absent or foreign
    * session is the same 404 for every role.
    */
   const scopeSession = async (user: { id: string; currentWorkspaceId: string | null }, id: string): Promise<string> =>
      (
         await resolveScopedResource(sql, user.id, currentWorkspace(user.currentWorkspaceId), 'product.write', (db) =>
            builder.get(db.ctx.workspaceId, id).catch(rethrow)
         )
      ).ctx.workspaceId;

   route.post('/sessions', async (context) => {
      const workspaceId = await scope(context.get('user'));
      return json(await builder.start(workspaceId, context.get('user').id), 201);
   });

   route.get('/sessions/:id', async (context) => {
      const id = sessionId(context.req.param('id'));
      const workspaceId = await scopeSession(context.get('user'), id);
      return json(await builder.get(workspaceId, id).catch(rethrow));
   });

   route.post('/sessions/:id/turns', async (context) => {
      const id = sessionId(context.req.param('id'));
      const workspaceId = await scopeSession(context.get('user'), id);
      const { prompt } = await readJson(context, turnSchema);
      return json(await builder.turn(workspaceId, id, prompt).catch(rethrow), 201);
   });

   route.post('/sessions/:id/apply', async (context) => {
      const user = context.get('user');
      const id = sessionId(context.req.param('id'));
      const workspaceId = await scopeSession(user, id);
      const { draftId } = await readJson(context, applySchema);
      // MCP servers are a settings.write resource (the mcp-servers mount); the
      // builder must not let someone without it create them.
      const allowMcp = await resolveScoped(sql, user.id, workspaceId, 'settings.write').then(
         () => true,
         () => false
      );
      const applied = await builder.apply(workspaceId, id, draftId, user.id, { allowMcp }).catch(rethrow);
      return json(applied, 201);
   });

   route.delete('/sessions/:id', async (context) => {
      const id = sessionId(context.req.param('id'));
      const workspaceId = await scopeSession(context.get('user'), id);
      await builder.discard(workspaceId, id).catch(rethrow);
      return new Response(null, { status: 204 });
   });

   return [{ prefix: '/api/v1/agent-builder', handler: route }];
}

function rethrow(error: unknown): never {
   if (error instanceof NotFound) throw ApiError.notFound('Builder session');
   if (error instanceof Conflict) {
      throw new ApiError(409, 'BUILDER_SESSION_CLOSED', 'This builder session is closed.');
   }
   if (error instanceof BuilderUnavailable) {
      throw new ApiError(503, 'AGENT_BUILDER_UNAVAILABLE', 'The agent builder needs the agent runtime.');
   }
   if (error instanceof BuilderMcpForbidden) {
      throw new ApiError(403, 'MCP_SETTINGS_REQUIRED', 'Only workspace admins can add MCP servers to an agent.');
   }
   if (error instanceof z.ZodError) {
      throw new ApiError(502, 'AGENT_BUILDER_INVALID_DRAFT', 'The builder produced a draft Berry could not use.');
   }
   throw error;
}
