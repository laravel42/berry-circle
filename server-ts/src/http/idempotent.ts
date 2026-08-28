import type { Context, MiddlewareHandler } from 'hono';
import { ApiError } from './errors.ts';
import { assertValid, fieldError } from './body.ts';
import type { AuthVariables } from '../auth/middleware.ts';
import {
   fingerprintJSON,
   validateIdempotencyKey,
   type ActorScope,
   type IdempotencyStore,
   type StoredResponse,
} from './idempotency.ts';

/**
 * Wraps a route so a repeated request replays rather than repeats.
 *
 * The claim is taken before the handler runs and completed with whatever it
 * returned, so a
 * client that retries after a timeout gets the original answer instead of a
 * second board, a second run, or a second charge.
 */

const MAX_BODY_BYTES = 64 * 1024;

export function idempotent(
   store: IdempotencyStore
): MiddlewareHandler<{ Variables: AuthVariables }> {
   return async (context, next) => {
      const key = readKey(context);
      const body = await context.req.raw.clone().text();
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
         throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      }

      let fingerprint: Buffer;
      try {
         fingerprint = fingerprintJSON(body);
      } catch {
         throw ApiError.badRequest('Request body must contain one valid JSON value.');
      }

      const scope: ActorScope = {
         actorType: 'user',
         actorId: context.get('user').id,
         method: context.req.method.toUpperCase(),
         // The path as routed, so two different boards do not share a claim.
         canonicalPath: new URL(context.req.url).pathname,
      };

      const claim = await store.begin(scope, key, fingerprint);
      if (claim.decision === 'conflict') {
         throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key was already used with a different request body.'
         );
      }
      if (claim.decision === 'in-progress') {
         // Not a conflict of intent — the same request is still running. The
         // client should wait rather than assume it failed.
         throw new RetryableConflict();
      }
      if (claim.decision === 'replay' && claim.response) {
         return replay(claim.response);
      }

      const claimId = claim.claimId!;
      let captured: Response;
      try {
         await next();
         captured = context.res;
      } catch (error) {
         // The handler failed, so nothing is worth replaying: release the key
         // rather than pinning this failure to it for a day.
         await store.abandon(claimId).catch(() => undefined);
         throw error;
      }

      const stored: StoredResponse = {
         status: captured.status,
         headers: headersOf(captured),
         body: await captured.clone().text(),
      };
      try {
         await store.complete(claimId, stored);
      } catch {
         await store.abandon(claimId).catch(() => undefined);
         // Go answers 500 when a successful response could not be recorded:
         // returning it while the claim is gone would let a retry run again.
         if (stored.status < 500) throw ApiError.internal();
      }
   };
}

/** A 409 that tells the client to wait rather than to change the request. */
class RetryableConflict extends ApiError {
   constructor() {
      super(409, 'CONFLICT', 'An identical request is already in progress.');
   }
}

export function isRetryableConflict(error: unknown): boolean {
   return error instanceof RetryableConflict;
}

function readKey(context: Context): string {
   // Headers.get joins repeats with ", ", so counting entries is the only way
   // to tell one key from two that concatenate into a valid-looking one.
   const values = [...context.req.raw.headers].filter(
      ([name]) => name.toLowerCase() === 'idempotency-key'
   );
   const key = values.length === 1 ? (values[0]?.[1] ?? '') : '';
   if (!validateIdempotencyKey(key)) {
      assertValid([
         fieldError(
            '/headers/Idempotency-Key',
            'invalid',
            'Idempotency-Key must contain 16 to 128 visible ASCII characters.'
         ),
      ]);
   }
   return key;
}

function headersOf(response: Response): Record<string, string[]> {
   const result: Record<string, string[]> = {};
   for (const [name, value] of response.headers) result[name] = [value];
   return result;
}

function replay(stored: StoredResponse): Response {
   const headers = new Headers();
   for (const [name, values] of Object.entries(stored.headers)) {
      for (const value of values) headers.append(name, value);
   }
   headers.set('Idempotency-Replayed', 'true');
   return new Response(stored.body, { status: stored.status, headers });
}
