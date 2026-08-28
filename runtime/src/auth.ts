import type { Context, Next } from 'hono';

/**
 * The only thing between the network and a service that runs arbitrary
 * commands on the host's Docker daemon.
 *
 * A missing token is refusal, not "no auth required". This service is reachable
 * from anything on the Compose network, and an unconfigured secret would make
 * it an open remote shell — so the failure mode has to be closed.
 */
export function authorize(expected: string) {
   return async function guard(context: Context, next: Next): Promise<Response | void> {
      if (expected === '') {
         return context.json({ error: 'runtime token is not configured' }, 503);
      }
      const header = context.req.header('authorization') ?? '';
      const prefix = 'Bearer ';
      if (!header.startsWith(prefix) || !constantTimeEqual(header.slice(prefix.length), expected)) {
         return context.json({ error: 'unauthorized' }, 401);
      }
      await next();
   };
}

/**
 * Compares without leaking where two strings first differ.
 *
 * `===` returns as soon as it finds a difference, and that timing is
 * measurable across enough requests. Length is compared separately and
 * deliberately: it leaks the token's length, which is not a secret, and
 * comparing different-length buffers byte by byte is where a naive constant
 * time check stops being constant.
 */
function constantTimeEqual(a: string, b: string): boolean {
   if (a.length !== b.length) return false;
   let difference = 0;
   for (let index = 0; index < a.length; index += 1) {
      difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
   }
   return difference === 0;
}
