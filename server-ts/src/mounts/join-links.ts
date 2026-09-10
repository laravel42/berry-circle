import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import type { SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';
import { acceptJoinLink, lookupJoinLink } from '../work/join-links.ts';
import { rethrowWork } from './work-errors.ts';

/**
 * `/api/v1/join-links/:token`: the one unauthenticated read in work tracking.
 * It reveals only the workspace name and role, and answers every unusable
 * token with the same 404 so tokens cannot be probed.
 */
export function joinLinkMounts(options: { sessions: SessionService; sql: Sql }): Mount[] {
   const { sql } = options;
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/:token', async (context) => {
      const found = await lookupJoinLink(sql, context.req.param('token') ?? '');
      if (!found) throw new ApiError(404, 'NOT_FOUND', 'This join link is not valid.');
      const response = json({
         workspace: { id: found.workspaceId, name: found.workspaceName },
         role: found.role,
         expiresAt: found.expiresAt,
      });
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   route.post('/:token/accept', requireSession(options.sessions), async (context) => {
      const result = await acceptJoinLink(sql, context.req.param('token') ?? '', context.get('user').id).catch(
         rethrowWork('Join link')
      );
      const response = json(result);
      response.headers.set('Cache-Control', 'no-store');
      return response;
   });

   return [{ prefix: '/api/v1/join-links', handler: route }];
}
