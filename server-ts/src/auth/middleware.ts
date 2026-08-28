import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.ts';
import { parseAuthorization, Unauthenticated } from './tokens.ts';
import type { SessionService, User } from './sessions.ts';

/**
 * Bearer authentication.
 *
 * Every failure — absent header, wrong scheme, malformed token, expired
 * session, revoked session — produces the identical 401 envelope. Nothing
 * distinguishes them, because a caller learning *why* a credential failed
 * learns something about credentials.
 */

export interface AuthVariables {
   user: User;
   requestId: string;
}

export function requireSession(sessions: SessionService): MiddlewareHandler<{
   Variables: AuthVariables;
}> {
   return async (context, next) => {
      // Exactly one Authorization header. Two is not a client Berry serves;
      // it is a proxy or an attacker stacking credentials, and picking one
      // would be choosing which to trust.
      const headers = context.req.raw.headers;
      const supplied = headers.get('authorization');
      if (supplied === null || countHeader(headers, 'authorization') !== 1) {
         throw ApiError.unauthorized();
      }

      let token: string;
      try {
         token = parseAuthorization(supplied);
      } catch (error) {
         if (error instanceof Unauthenticated) throw ApiError.unauthorized();
         throw error;
      }

      let user: User;
      try {
         // Any credential, not only a session: a personal access token is a
         // first-class way to call this API, and dispatch is by prefix.
         user = await sessions.resolveCredential(token);
      } catch {
         // Deliberately catching everything: a database failure here must not
         // become a 500 that tells a caller their token was probably valid.
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

/**
 * Counts occurrences of a header.
 *
 * `Headers.get` joins repeated values with ", " and gives no way to tell one
 * header containing a comma from two headers. `getSetCookie` is the only
 * per-name accessor, so counting means walking the entries.
 */
function countHeader(headers: Headers, name: string): number {
   let count = 0;
   for (const [key] of headers) if (key.toLowerCase() === name) count += 1;
   return count;
}
