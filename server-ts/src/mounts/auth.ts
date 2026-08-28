import { Hono } from 'hono';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import {
   InvalidCredentials,
   serializeUser,
   type SessionService,
} from '../auth/sessions.ts';
import { parseAuthorization } from '../auth/tokens.ts';
import { json } from '../http/app.ts';
import { ApiError } from '../http/errors.ts';
import type { Mount } from '../http/registry.ts';

/**
 * `/api/v1/auth`.
 *
 * The first mount the browser actually depends on: `frontend/lib/session.ts`
 * calls login, keeps the raw token in a closure and sessionStorage, and sends
 * it as a bearer on every request thereafter.
 */

const MAX_LOGIN_BODY_BYTES = 4096;

/** Gates the known-email login path. */
export interface LoginConfig {
   allowKnownEmail: boolean;
   environment: string;
}

export interface AuthOptions {
   sessions: SessionService;
   login: LoginConfig;
}

/**
 * Known-email login is a development affordance and is refused anywhere else,
 * whatever the flag says. `AUTH_ALLOW_PASSWORDLESS_LOGIN` defaults to true in
 * compose, so the environment check is what stops that reaching production.
 */
function loginAllowed(config: LoginConfig): boolean {
   const environment = config.environment.trim().toLowerCase();
   return config.allowKnownEmail && (environment === 'development' || environment === 'test');
}

export function authMounts(options: AuthOptions): Mount[] {
   const route = new Hono<{ Variables: AuthVariables }>();

   route.post('/login', async (context) => {
      if (!loginAllowed(options.login)) throw ApiError.routeNotFound();

      const body = await readJsonBody(context.req.raw);
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!email || !looksLikeEmail(email)) {
         // The same envelope an unknown address gets: a validation error here
         // would tell a caller which addresses are worth trying.
         throw invalidCredentials();
      }

      try {
         const issued = await options.sessions.issueKnownEmail(email, {
            userAgent: context.req.header('user-agent') ?? null,
            ip: clientIp(context.req.raw),
         });
         return json({
            token: issued.token,
            expiresAt: issued.expiresAt,
            user: serializeUser(issued.user),
         });
      } catch (error) {
         if (error instanceof InvalidCredentials) throw invalidCredentials();
         throw error;
      }
   });

   route.post('/logout', requireSession(options.sessions), async (context) => {
      // The header parsed once already in the middleware; re-reading it here
      // is what lets revocation target this exact token rather than the user.
      const token = parseAuthorization(context.req.header('authorization'));
      await options.sessions.revokeSession(token);
      return new Response(null, { status: 204 });
   });

   route.get('/me', requireSession(options.sessions), (context) =>
      json(serializeUser(context.get('user')))
   );

   return [{ prefix: '/api/v1/auth', handler: route }];
}

function invalidCredentials(): ApiError {
   return new ApiError(401, 'UNAUTHENTICATED', 'Invalid credentials.');
}

/**
 * Reads a bounded JSON body.
 *
 * Bounded because this route is unauthenticated: anything reachable without a
 * credential must not let a caller decide how much memory to spend.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
   const declared = Number(request.headers.get('content-length') ?? '0');
   if (declared > MAX_LOGIN_BODY_BYTES) throw ApiError.badRequest('The request body is too large.');

   const text = await request.text();
   if (text.length > MAX_LOGIN_BODY_BYTES) {
      throw ApiError.badRequest('The request body is too large.');
   }
   if (!text.trim()) return {};
   try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null
         ? (parsed as Record<string, unknown>)
         : {};
   } catch {
      throw ApiError.badRequest('The request body is not valid JSON.');
   }
}

/** Deliberately permissive: storage decides who exists, not this check. */
function looksLikeEmail(value: string): boolean {
   return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

function clientIp(request: Request): string | null {
   const forwarded = request.headers.get('x-forwarded-for');
   if (!forwarded) return null;
   const first = forwarded.split(',')[0]?.trim();
   return first && first.length <= 45 ? first : null;
}
