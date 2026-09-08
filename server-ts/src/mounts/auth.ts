import { Hono, type Context } from 'hono';
import type { Sql } from '../db/pool.ts';
import { requireSession, type AuthVariables } from '../auth/middleware.ts';
import {
   InvalidCredentials,
   serializeUser,
   type SessionService,
} from '../auth/sessions.ts';
import { hashPassword } from '../auth/password.ts';
import { parseAuthorization } from '../auth/tokens.ts';
import { signInBody, signUpBody, toFieldErrors } from '../auth/schemas.ts';
import { json } from '../http/app.ts';
import { assertValid, fieldError, ValidationFailed } from '../http/body.ts';
import { ApiError } from '../http/errors.ts';
import { fingerprintJSON, validateIdempotencyKey } from '../http/idempotency.ts';
import { domain } from '../identity/errors.ts';
import type { IdentityRepository } from '../identity/repository.ts';
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
   /** Sign-up creates the user row here; the same pool backs the create+issue transaction. */
   identity: IdentityRepository;
   sql: Sql;
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

   route.post('/sign-in', async (context) => {
      // Bounded read first: this route is unauthenticated, so an over-size
      // body is a 400 before any parsing spends memory on it.
      const body = await readJsonBody(context.req.raw);

      // Shape and policy only. A failure names `/email` or `/password` via the
      // shared FieldError contract; it never reveals whether the address is
      // registered.
      const parsed = signInBody.safeParse(body);
      if (!parsed.success) throw new ValidationFailed(toFieldErrors(parsed.error));

      try {
         const issued = await options.sessions.issuePassword(
            parsed.data.email,
            parsed.data.password,
            {
               userAgent: context.req.header('user-agent') ?? null,
               ip: clientIp(context.req.raw),
            }
         );
         return json({
            token: issued.token,
            expiresAt: issued.expiresAt,
            user: serializeUser(issued.user),
         });
      } catch (error) {
         // Unknown email and wrong password are one uniform 401: distinguishing
         // them would tell a caller which addresses exist.
         if (error instanceof InvalidCredentials) throw invalidCredentials();
         throw error;
      }
   });

   route.post('/sign-up', async (context) => {
      // The key is read before the body so a malformed one is a 422 for the
      // same reason a malformed body is: the request is not well-formed. Unlike
      // workspace create, the key is optional here — a sign-up with no key is
      // always a fresh account (Property 8).
      const key = optionalIdempotencyKey(context.req.raw.headers);

      // Bounded read first: this route is unauthenticated, so an over-size body
      // is a 400 before any parsing spends memory on it. `raw` is kept so the
      // fingerprint is taken over exactly what arrived, matching every other
      // idempotent create.
      const { body, raw } = await readSignUpBody(context.req.raw);

      const parsed = signUpBody.safeParse(body);
      if (!parsed.success) throw new ValidationFailed(toFieldErrors(parsed.error));

      // Hash outside the transaction: scrypt is deliberately slow, and holding a
      // row lock open for it would serialise unrelated sign-ups.
      const stored = await hashPassword(parsed.data.password);

      const issued = await domain('User', () =>
         options.sql.begin(async (tx) => {
            const { userId } = await options.identity.createUserWithPassword(tx, {
               email: parsed.data.email,
               // No name field on the wire yet; the address is the initial name,
               // matching the passwordless accounts already in the table.
               name: parsed.data.email,
               passwordHash: stored.hash,
               passwordSalt: stored.salt,
               idempotencyKey: key,
               fingerprint: key === null ? null : fingerprintJSON(raw),
            });
            // Same transaction: a failure to issue rolls the user back, so a
            // sign-up never leaves an account no session was ever minted for.
            return options.sessions.issueForUser(
               userId,
               {
                  userAgent: context.req.header('user-agent') ?? null,
                  ip: clientIp(context.req.raw),
               },
               tx
            );
         })
      );

      // 201 whether freshly created or replayed: a replay returns the same
      // account, re-serialised, exactly as workspace create does.
      return json(
         {
            token: issued.token,
            expiresAt: issued.expiresAt,
            user: serializeUser(issued.user),
         },
         201
      );
   });

   // Shared by `/sign-out` and its `/logout` alias so the two cannot drift.
   // The header parsed once already in the middleware; re-reading it here is
   // what lets revocation target this exact token rather than the user. Always
   // 204, including for a token matching no stored session — `revokeSession`
   // is a no-op for an unknown token.
   const signOut = async (context: Context<{ Variables: AuthVariables }>) => {
      const token = parseAuthorization(context.req.header('authorization'));
      await options.sessions.revokeSession(token);
      return new Response(null, { status: 204 });
   };

   route.post('/sign-out', requireSession(options.sessions), signOut);
   // Retained as an alias so the current frontend keeps working during migration.
   route.post('/logout', requireSession(options.sessions), signOut);

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

/**
 * The Idempotency-Key for sign-up, or null when none was sent.
 *
 * Optional, unlike the workspace-create key: a sign-up with no key is a fresh
 * account, not an error. A key that is present but not one visible-ASCII value
 * of 16..128 characters is a 422, the same as a malformed body, and two keys
 * across two headers count as neither (they concatenate into one that is not
 * what either sender meant).
 */
function optionalIdempotencyKey(headers: Headers): string | null {
   const values = [...headers].filter(([name]) => name.toLowerCase() === 'idempotency-key');
   if (values.length === 0) return null;
   const key = values.length === 1 ? (values[0]?.[1] ?? '') : '';
   if (!validateIdempotencyKey(key)) {
      assertValid([
         fieldError(
            '/headers/Idempotency-Key',
            'invalid',
            'Idempotency-Key must be one visible ASCII value from 16 to 128 characters.'
         ),
      ]);
   }
   return key;
}

/**
 * Reads a bounded JSON body and returns the raw bytes alongside the decoded
 * object. The raw text is what the idempotency fingerprint is taken over —
 * over exactly what arrived, not a re-serialisation of it.
 */
async function readSignUpBody(
   request: Request
): Promise<{ body: Record<string, unknown>; raw: string }> {
   const declared = Number(request.headers.get('content-length') ?? '0');
   if (declared > MAX_LOGIN_BODY_BYTES) throw ApiError.badRequest('The request body is too large.');

   const raw = await request.text();
   if (Buffer.byteLength(raw, 'utf8') > MAX_LOGIN_BODY_BYTES) {
      throw ApiError.badRequest('The request body is too large.');
   }
   if (!raw.trim()) return { body: {}, raw };
   try {
      const parsed: unknown = JSON.parse(raw);
      const body =
         typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)
            : {};
      return { body, raw };
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
