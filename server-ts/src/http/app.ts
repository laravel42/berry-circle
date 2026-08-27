import { Hono } from 'hono';
import { ApiError, buildErrorEnvelope } from './errors.ts';
import { isValidRequestId, newRequestId } from './request-id.ts';
import type { Registry } from './registry.ts';

/**
 * The application shell: request ids, the single error path, and the two
 * envelopes the router itself answers with.
 *
 * Everything a client can observe here is a contract the Go server already
 * publishes — `frontend/lib/api.ts` reads `x-request-id` and parses the error
 * envelope — so this file exists to make the two servers indistinguishable
 * rather than to express a preference.
 */

export interface AppVariables {
   requestId: string;
}

export type BerryApp = Hono<{ Variables: AppVariables }>;

export function createApp(registry: Registry): BerryApp {
   const app = new Hono<{ Variables: AppVariables }>();

   // A client may supply its own correlation id, but only a safe one: an
   // arbitrary header value ends up in logs and in the error envelope.
   app.use('*', async (context, next) => {
      const supplied = context.req.header('x-request-id');
      const requestId = isValidRequestId(supplied) ? supplied : newRequestId();
      context.set('requestId', requestId);
      context.header('X-Request-Id', requestId);
      await next();
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
   return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId },
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
   return new Response(JSON.stringify(value), {
      status,
      headers: { 'Content-Type': 'application/json' },
   });
}
