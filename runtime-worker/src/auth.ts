import type { Context, Next } from 'hono';
import type { Env } from './index.ts';

/**
 * The only thing standing between the open internet and a container that runs
 * arbitrary commands.
 *
 * A missing token on the worker is treated as refusal rather than as "no auth
 * required". A deployment that forgot `wrangler secret put` would otherwise be
 * an open remote shell, and the failure mode of an unconfigured secret must be
 * closed.
 */
export async function authorize(
   context: Context<{ Bindings: Env }>,
   next: Next
): Promise<Response | void> {
   const expected = context.env.BERRY_RUNTIME_TOKEN;
   if (typeof expected !== 'string' || expected === '') {
      return context.json({ error: 'runtime token is not configured' }, 503);
   }

   const header = context.req.header('authorization') ?? '';
   const prefix = 'Bearer ';
   if (!header.startsWith(prefix)) {
      return context.json({ error: 'unauthorized' }, 401);
   }

   if (!constantTimeEqual(header.slice(prefix.length), expected)) {
      return context.json({ error: 'unauthorized' }, 401);
   }
   await next();
}

/**
 * Compares without leaking where two strings first differ.
 *
 * `===` returns as soon as it finds a difference, and the time that takes is
 * measurable across enough requests. The length is compared separately and
 * deliberately — it leaks the token's length, which is not a secret, and
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
