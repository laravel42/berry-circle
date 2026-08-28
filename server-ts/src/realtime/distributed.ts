import { normalizeEvent, type Event } from './event.ts';
import type { Broadcaster, Hub, Observer, Subscription } from './hub.ts';
import type { Relay } from './relay.ts';

/**
 * The hub and the relay together.
 *
 * Publishing means two things: deliver to this node's subscribers now, and
 * tell the other nodes. Receiving means the reverse. The pieces that make that
 * safe are the deduper — the same event arrives locally and again off the
 * stream — and a reader that reconnects with backoff rather than giving up.
 */

const DEFAULT_DEDUPE_ENTRIES = 8192;
const DEFAULT_DEDUPE_TTL_MS = 20 * 60 * 1000;
const MIN_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 5_000;

export interface DistributedConfig {
   /** When true, a failed relay publish fails the request rather than degrading. */
   required?: boolean;
   dedupeEntries?: number;
   dedupeTtlMs?: number;
   observer?: Observer;
   logger?: (message: string) => void;
}

export class Distributed implements Broadcaster {
   private readonly hub: Hub;
   private readonly relay: Relay | null;
   private readonly required: boolean;
   private readonly observer: Observer | undefined;
   private readonly logger: (message: string) => void;
   private readonly dedupe: EventDeduper;
   private healthy = false;
   private reading = false;
   private controller: AbortController | null = null;
   private runner: Promise<void> | null = null;
   private closed = false;

   constructor(hub: Hub, relay: Relay | null, config: DistributedConfig = {}) {
      if (config.required && relay === null) {
         throw new Error('required realtime relay is unavailable');
      }
      const entries = config.dedupeEntries ?? DEFAULT_DEDUPE_ENTRIES;
      if (!Number.isInteger(entries) || entries < 1 || entries > 1_000_000) {
         throw new Error('realtime dedupe capacity is invalid');
      }
      const ttl = config.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
      if (ttl < 1_000 || ttl > 24 * 60 * 60 * 1000) {
         throw new Error('realtime dedupe TTL is invalid');
      }

      this.hub = hub;
      this.relay = relay;
      this.required = config.required ?? false;
      this.observer = config.observer;
      this.logger = config.logger ?? (() => undefined);
      this.dedupe = new EventDeduper(entries, ttl);
      hub.setObserver(config.observer);
      // With no relay there is nothing to be unhealthy about.
      if (relay === null) this.healthy = true;
   }

   async publish(event: Event): Promise<void> {
      const normalized = normalizeEvent(event);

      // Local delivery first, and only once: an event already seen came from
      // the relay, and its subscribers have had it.
      if (!this.dedupe.seen(normalized.id)) {
         try {
            await this.hub.publish(normalized);
         } catch (error) {
            // The id is released so a retry is not silently swallowed.
            this.dedupe.forget(normalized.id);
            throw error;
         }
      }
      if (this.relay === null) return;

      try {
         await this.relay.publish(normalized);
         if (this.reading) this.markConnected();
      } catch (error) {
         this.markDisconnected();
         this.observer?.({ kind: 'relayPublishFailed' });
         this.logger('realtime relay publish failed');
         // Degrading is the default: local subscribers already have the event
         // and the fact is in PostgreSQL, so a relay outage costs other nodes
         // their live update, not the write.
         if (this.required) throw error;
      }
   }

   subscribe(workspaceId: string): Promise<Subscription> {
      return this.hub.subscribe(workspaceId);
   }

   /** Launches the reconnecting reader. */
   start(): void {
      if (this.closed) throw new Error('realtime broadcaster is closed');
      if (this.controller) throw new Error('realtime broadcaster is already started');
      this.controller = new AbortController();
      this.runner = this.run(this.controller.signal);
   }

   private async run(signal: AbortSignal): Promise<void> {
      if (this.relay === null) return;
      let backoff = MIN_BACKOFF_MS;

      while (!signal.aborted) {
         try {
            await this.relay.ping();
            await this.relay.prepare();
         } catch {
            this.markDisconnected();
            if (!(await waitForRetry(backoff, signal))) return;
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            continue;
         }

         this.reading = true;
         this.markConnected();
         const connectedAt = Date.now();
         try {
            await this.relay.run((event) => this.receive(event), signal);
         } catch {
            this.logger('realtime relay reader disconnected');
         } finally {
            this.reading = false;
         }
         if (signal.aborted) return;
         this.markDisconnected();

         // A connection that lasted is evidence the backend is fine, so the
         // next failure starts from the short delay again rather than
         // inheriting the backoff of an outage that is over.
         if (Date.now() - connectedAt >= 30_000) backoff = MIN_BACKOFF_MS;
         if (!(await waitForRetry(backoff, signal))) return;
         backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
   }

   private async receive(event: Event): Promise<void> {
      if (this.reading) this.markConnected();
      if (event.originNodeId && this.relay && event.originNodeId === this.relay.nodeId) return;
      if (this.dedupe.seen(event.id)) return;
      await this.hub.publish(event);
   }

   private markConnected(): void {
      if (this.healthy) return;
      this.healthy = true;
      // The cursor only survives a short gap, and stream trimming may have
      // dropped an event nobody saw — so clients are disconnected to resync
      // rather than left believing they are current.
      this.hub.disconnectAll();
      this.observer?.({ kind: 'relayReconnected' });
   }

   private markDisconnected(): void {
      this.healthy = false;
   }

   isHealthy(): boolean {
      return this.healthy;
   }

   async check(): Promise<void> {
      if (this.relay === null) return;
      await this.relay.ping();
   }

   async close(): Promise<void> {
      if (this.closed) return;
      this.closed = true;
      this.controller?.abort();
      await this.runner?.catch(() => undefined);
      await this.relay?.close();
      this.hub.close();
   }
}

/**
 * Remembers recently seen event ids.
 *
 * An event published here also comes back off the relay, and a node that
 * delivered both would show every action twice. Bounded by count and by age,
 * because the alternative is a map that grows for the life of the process.
 */
class EventDeduper {
   private readonly max: number;
   private readonly ttlMs: number;
   private readonly entries = new Map<string, number>();

   constructor(max: number, ttlMs: number) {
      this.max = max;
      this.ttlMs = ttlMs;
   }

   /** True for a live duplicate; records the id otherwise. */
   seen(id: string): boolean {
      const now = Date.now();
      this.prune(now);
      const expiresAt = this.entries.get(id);
      if (expiresAt !== undefined && expiresAt > now) return true;

      // Re-inserting moves the id to the end, so Map iteration order is
      // insertion order and the oldest entry is the first one.
      this.entries.delete(id);
      this.entries.set(id, now + this.ttlMs);
      while (this.entries.size > this.max) {
         const oldest = this.entries.keys().next();
         if (oldest.done) break;
         this.entries.delete(oldest.value);
      }
      return false;
   }

   forget(id: string): void {
      this.entries.delete(id);
   }

   private prune(now: number): void {
      for (const [id, expiresAt] of this.entries) {
         // Insertion order is expiry order, so the first live entry ends it.
         if (expiresAt > now) return;
         this.entries.delete(id);
      }
   }
}

/** Resolves false when the wait was cut short by shutdown. */
function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
   if (signal.aborted) return Promise.resolve(false);
   return new Promise((resolve) => {
      const timer = setTimeout(() => {
         signal.removeEventListener('abort', onAbort);
         resolve(true);
      }, delayMs);
      function onAbort() {
         clearTimeout(timer);
         resolve(false);
      }
      signal.addEventListener('abort', onAbort, { once: true });
   });
}
