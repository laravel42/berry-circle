import { BerryClient } from './client.ts';
import { SIGNATURE_HEADER, verifySignature } from './signature.ts';
import type { HookRequest } from './types.ts';

type Hook = (request: HookRequest, api: BerryClient) => Promise<void>;

/**
 * A fetch-style handler for hook calls (works with any server that speaks
 * `Request`/`Response`). The signature is checked over the raw body before
 * anything is parsed. If your hook writes back to Berry, remember Berry will
 * tell you about that write too — skip events you caused.
 */
export function createHookHandler(options: {
   signingSecret: string;
   onEvent?: Hook;
   onSchedule?: Hook;
}): (request: Request) => Promise<Response> {
   return async (request) => {
      const body = await request.text();
      if (!verifySignature({ secret: options.signingSecret, header: request.headers.get(SIGNATURE_HEADER), body })) {
         return new Response('invalid signature', { status: 401 });
      }
      const hook = JSON.parse(body) as HookRequest;
      const api = new BerryClient({ apiUrl: hook.api.url ?? '', token: hook.api.token });
      const handler = hook.type === 'event' ? options.onEvent : options.onSchedule;
      if (handler) await handler(hook, api);
      return new Response(null, { status: 204 });
   };
}
