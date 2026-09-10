import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.ts';
import { CrossOriginRefused, type SessionService, type User } from './sessions.ts';

/**
 * Authentication for every signed-in mount: a Better Auth session cookie, or
 * one bearer token (see SessionService).
 *
 * Every failure — no credential, a malformed header, an unknown or revoked
 * token, an expired session, a database error while checking — is the
 * identical 401 envelope. Nothing distinguishes them, because a caller
 * learning *why* a credential failed learns something about credentials. The
 * one exception is a cookie write from a foreign origin, a 403: it says
 * nothing about the credential, only about where the request came from.
 */

export interface AuthVariables {
   user: User;
   requestId: string;
}

export function requireSession(sessions: SessionService): MiddlewareHandler<{
   Variables: AuthVariables;
}> {
   return async (context, next) => {
      let user: User;
      try {
         user = await sessions.resolveRequest(context.req.raw);
      } catch (error) {
         if (error instanceof CrossOriginRefused) throw ApiError.forbidden();
         // Deliberately everything else: a database failure here must not
         // become a 500 that tells a caller their credential was probably valid.
         throw ApiError.unauthorized();
      }
      context.set('user', user);
      await next();
   };
}

/** Requires an authenticated user to hold one of the given roles. */
export function requireRole(...allowed: string[]): MiddlewareHandler<{ Variables: AuthVariables }> {
   return async (context, next) => {
      const user = context.get('user');
      // Runs after requireSession, so an absent user is a wiring mistake
      // rather than an anonymous caller — and it still must not fall open.
      if (!user || !allowed.includes(user.role)) throw ApiError.forbidden();
      await next();
   };
}
