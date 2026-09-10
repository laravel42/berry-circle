import { Hono } from 'hono';
import type { Mount } from '../http/registry.ts';
import { AUTH_BASE_PATH } from '../auth/better-auth.ts';

/**
 * `/api/auth/*` — Better Auth's own routes: start GitHub sign-in, the OAuth
 * callback, read and end the session. Beside `/api/v1`, not under it, because
 * these are Better Auth's wire shapes rather than Berry's contract.
 */
export function betterAuthMounts(auth: {
   handler(request: Request): Promise<Response>;
}): Mount[] {
   const route = new Hono();
   route.on(['GET', 'POST'], '/*', async (context) => {
      const response = await auth.handler(context.req.raw);
      // Re-wrapped so the headers are mutable: a redirect built with
      // Response.redirect() has immutable headers, and the app shell stamps
      // its security headers onto every response.
      return new Response(response.body, response);
   });
   return [{ prefix: AUTH_BASE_PATH, handler: route }];
}
