import type { Message } from '@strands-agents/sdk';
import type { LocalSession } from './local-session.ts';

/**
 * The sessions this microVM holds warm.
 *
 * AgentCore routes every invoke carrying one `runtimeSessionId` to the same
 * microVM while it lives, so this map is what makes a follow-up run on an
 * issue continue the conversation instead of starting over. Work on one
 * session is serialised: two runs never share a session concurrently on the
 * server side (`issues.active_run_id`), but a retry can arrive while the loop
 * of the run it replaces is still finishing after its stream closed.
 */

export interface WarmSession {
   key: string;
   /** Changes when the agent's configuration does; a mismatch restarts cold. */
   fingerprint: string;
   messages: Message[];
   workspace: LocalSession;
   lastUsedAt: number;
}

export class SessionRegistry {
   readonly #sessions = new Map<string, WarmSession>();
   readonly #tails = new Map<string, Promise<unknown>>();
   readonly #controllers = new Map<string, AbortController>();
   #active = 0;

   /** True while any loop is working — `/ping` answers `HealthyBusy`. */
   get busy(): boolean {
      return this.#active > 0;
   }

   get size(): number {
      return this.#sessions.size;
   }

   get(key: string): WarmSession | undefined {
      return this.#sessions.get(key);
   }

   set(entry: WarmSession): void {
      this.#sessions.set(entry.key, entry);
   }

   drop(key: string): void {
      this.#sessions.delete(key);
   }

   async exclusive<T>(key: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const previous = this.#tails.get(key) ?? Promise.resolve();
      const controller = new AbortController();
      const next = previous
         .catch(() => undefined)
         .then(async () => {
            this.#active += 1;
            this.#controllers.set(key, controller);
            try {
               return await work(controller.signal);
            } finally {
               this.#active -= 1;
               if (this.#controllers.get(key) === controller) this.#controllers.delete(key);
            }
         });
      this.#tails.set(key, next);
      try {
         return await next;
      } finally {
         if (this.#tails.get(key) === next) this.#tails.delete(key);
      }
   }

   /** The local stand-in for `StopRuntimeSession`: abort the loop and forget the session. */
   stop(key: string): boolean {
      const controller = this.#controllers.get(key);
      controller?.abort();
      const held = this.#sessions.delete(key);
      return held || controller !== undefined;
   }
}
