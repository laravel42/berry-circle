import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import { serializeUser, type SessionService } from '../auth/sessions.ts';
import type { Sql } from '../db/pool.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/auth`.
 *
 * Signing in and out is Better Auth's, at `/api/auth/*` (mounts/better-auth.ts),
 * and GitHub is the only way in. What stays here is `GET /me`, which answers
 * for any credential — the browser's cookie or an API client's token — and,
 * in development only, `POST /dev-login`.
 */

export interface AuthOptions {
   sessions: SessionService;
   sql: Sql;
   /**
    * Development only: Set-Cookie values for a session belonging to a user id.
    * Null — and the route absent — anywhere config.auth.devLogin is false,
    * which it always is outside development and test.
    */
   devSession: ((userId: string) => Promise<string[]>) | null;
}

const MAX_DEV_LOGIN_BODY_BYTES = 1024;

export function authMounts(options: AuthOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   route.get('/me', requireSession(options.sessions), (context) =>
      json(serializeUser(context.get('user')))
   );

   const devSession = options.devSession;
   if (devSession) {
      /**
       * Signs in as an existing account by email, with no GitHub round trip,
       * so a local stack with no OAuth App still has a way in. Not a sign-in
       * method: it is never registered outside development and test.
       */
      route.post('/dev-login', async (context) => {
         const text = await context.req.raw.text();
         if (Buffer.byteLength(text, 'utf8') > MAX_DEV_LOGIN_BODY_BYTES) {
            throw ApiError.badRequest('The request body is too large.');
         }
         let email = '';
         try {
            const parsed: unknown = JSON.parse(text || '{}');
            if (
               parsed &&
               typeof parsed === 'object' &&
               typeof (parsed as { email?: unknown }).email === 'string'
            ) {
               email = (parsed as { email: string }).email.trim();
            }
         } catch {
            throw ApiError.badRequest('The request body is not valid JSON.');
         }
         const [row] = email
            ? await options.sql`SELECT id FROM users WHERE lower(email) = lower(${email}) LIMIT 1`
            : [];
         // The uniform 401: an unknown email looks like every other failed
         // credential.
         if (!row) throw ApiError.unauthorized();

         const user = await options.sessions.loadUser(row.id as string);
         const response = json({ user: serializeUser(user) });
         for (const cookie of await devSession(user.id)) {
            response.headers.append('set-cookie', cookie);
         }
         return response;
      });
   }

   return [{ prefix: '/api/v1/auth', handler: route }];
}
