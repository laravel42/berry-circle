import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import { serializeUser, type SessionService } from '../auth/sessions.ts';
import { json } from '../http/app.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/auth`.
 *
 * Signing in and out is Better Auth's, at `/api/auth/*` (mounts/better-auth.ts),
 * and GitHub is the only way in. What stays here is `GET /me`, which answers
 * for any credential — the browser's cookie or an API client's token.
 */

export interface AuthOptions {
   sessions: SessionService;
}

export function authMounts(options: AuthOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/me', requireSession(options.sessions), (context) =>
      json(serializeUser(context.get('user')))
   );

   return [{ prefix: '/api/v1/auth', handler: route }];
}
