import type { LifecycleEvent } from '../../../runtime/lifecycle.ts';
import type { RuntimeTransport } from '../../../runtime/transport.ts';
import { handleInvocation, type HandlerDeps } from './handler.ts';

/**
 * The runtime, called as a function. For tests of the server-side executor
 * against the real container handler and a ScriptedModel; never wired in
 * production, because it would load the model SDK into the server process.
 */
export function inProcessTransport(deps: HandlerDeps): RuntimeTransport {
   return {
      async *invoke({ envelope }) {
         const queue: LifecycleEvent[] = [];
         let done = false;
         let wake: (() => void) | null = null;
         const running = handleInvocation(envelope, (event) => {
            queue.push(event);
            wake?.();
         }, deps).finally(() => {
            done = true;
            wake?.();
         });
         while (true) {
            const next = queue.shift();
            if (next) {
               yield next;
               continue;
            }
            if (done) break;
            await new Promise<void>((resolve) => {
               wake = resolve;
            });
         }
         await running;
      },
      async stop({ runtimeSessionId }) {
         deps.registry.stop(runtimeSessionId);
      },
   };
}
