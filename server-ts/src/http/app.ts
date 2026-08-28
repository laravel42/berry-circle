import { Hono } from 'hono';
import { ApiError, DecoratedApiError, buildErrorEnvelope } from './errors.ts';
import { isValidRequestId, newRequestId } from './request-id.ts';
import type { Registry } from './registry.ts';

/**
 * The application shell: request ids, the single error path, and the two
 * envelopes the router itself answers with.
 *
 * Everything a client can observe here is a published contract —
 * `frontend/lib/api.ts` reads `x-request-id` and parses the error envelope —
 * so this file exists to hold that shape fixed rather than to express a
 * preference.
 */

export interface AppVariables {
   requestId: string;
}

export type BerryApp = Hono<{ Variables: AppVariables }>;

export function createApp(registry: Registry): BerryApp {
   const app = new Hono<{ Variables: AppVariables }>();

   // A client may supply its own correlation id, but only a safe one: an
   // arbitrary header value ends up in logs and in the error envelope.
   //
   // Headers are applied to the finished response rather than through
   // context.header, because handlers return their own Response objects and a
   // fresh Response does not inherit what Hono accumulated on the context.
   // That is how this server shipped with no security headers at all: they
   // were being set somewhere the response never looked.
   app.use('*', async (context, next) => {
      const supplied = context.req.header('x-request-id');
      const requestId = isValidRequestId(supplied) ? supplied : newRequestId();
      context.set('requestId', requestId);
      await next();
      applyStandardHeaders(context.res.headers, requestId);
   });

   registry.attach(app);

   app.notFound((context) =>
      respondWithError(context.get('requestId'), ApiError.routeNotFound())
   );

   app.onError((error, context) => {
      const requestId = context.get('requestId') ?? newRequestId();
      if (error instanceof ApiError) return respondWithError(requestId, error);
      // An unexpected throw is never described to the client: the message may
      // carry a query, a path or a credential. It is logged and answered with
      // the constant envelope.
      console.error(JSON.stringify({ level: 'error', msg: 'unhandled request error', requestId, error: String(error) }));
      return respondWithError(requestId, ApiError.internal());
   });

   return app;
}

/**
 * The security headers set on every response.
 *
 * Set here, once, rather than per mount. A browser applies whichever it is
 * given, so a response that slipped out without them would be protected only
 * by whichever route happened to add its own.
 */
const STANDARD_HEADERS: ReadonlyArray<readonly [string, string]> = [
   ['X-Content-Type-Options', 'nosniff'],
   ['X-Frame-Options', 'DENY'],
   ['Referrer-Policy', 'no-referrer'],
   ['Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"],
   ['Permissions-Policy', 'camera=(), microphone=(), geolocation=()'],
];

export function applyStandardHeaders(headers: Headers, requestId: string): void {
   for (const [name, value] of STANDARD_HEADERS) headers.set(name, value);
   headers.set('X-Request-Id', requestId);
}

function respondWithError(requestId: string, error: ApiError): Response {
   const { status, body } = buildErrorEnvelope(
      error.status,
      error.code,
      error.message,
      error.details,
      requestId
   );
   // A plain Response with JSON.stringify rather than Hono's context.json, so
   // the key order written in buildErrorEnvelope is the key order on the wire.
   return new Response(JSON.stringify(body) + '\n', {
      status,
      headers: {
         'Content-Type': 'application/json',
         'X-Request-Id': requestId,
         // A failed request for a secret is still a response about a secret.
         ...(error instanceof DecoratedApiError ? error.headers : {}),
      },
   });
}

/**
 * A JSON response whose key order is the order it was constructed in.
 *
 * Go marshals a struct in field-declaration order and a map in sorted-key
 * order, and the frontend's tests compare whole bodies. Constructing the
 * object in the order Go emits and serializing it directly is what keeps the
 * two identical.
 */
export function json(value: unknown, status = 200): Response {
   // The trailing newline is Go's, not a flourish: json.NewEncoder(w).Encode
   // writes one, so every Berry response ends in 0x0a today. One byte, and the
   // difference between "identical" and "nearly" when responses are compared.
   return new Response(goJSON(value) + '\n', {
      status,
      headers: { 'Content-Type': 'application/json' },
   });
}

/**
 * `JSON.stringify` with Go's escaping.
 *
 * `encoding/json` escapes `<`, `>` and `&` by default — for callers embedding
 * JSON in HTML — and escapes U+2028/U+2029, which JavaScript leaves literal.
 * Nothing else differs for a value built in the order Go declares its fields.
 *
 * Applied to the finished text rather than during serialization, which is
 * safe because none of these characters is JSON syntax: wherever one appears
 * in the output it is inside a string literal, and `JSON.stringify` has
 * already escaped the characters that would confuse this.
 *
 * The cost of getting it wrong is invisible until it isn't. Every ported
 * mount looked byte-identical to Go for weeks, because none of the data
 * compared happened to contain an ampersand — and then a stream of 4,090
 * events contained three that did.
 */
export function goJSON(value: unknown): string {
   return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => GO_ESCAPES[character]!);
}

const GO_ESCAPES: Record<string, string> = {
   '<': String.raw`\u003c`,
   '>': String.raw`\u003e`,
   '&': String.raw`\u0026`,
   '\u2028': String.raw`\u2028`,
   '\u2029': String.raw`\u2029`,
};
