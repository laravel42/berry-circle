import { eventScopes, normalizeEvent, type Event } from './event.ts';

/**
 * The in-process broadcaster.
 *
 * Every subscriber gets a fixed-size buffer, and one that fills it is
 * disconnected rather than waited for. That is the whole design: an event is a
 * projection of a fact already in PostgreSQL, so a client that misses one
 * reconnects and refetches — whereas a hub that buffered for a stalled browser
 * would grow without bound until the process died, taking every other client
 * with it.
 */

export interface Observation {
   kind: 'slowSubscriber' | 'relayPublishFailed' | 'relayEventRejected' | 'relayReconnected';
}

export type Observer = (observation: Observation) => void;

/**
 * One subscriber's bounded queue.
 *
 * Node has no channel, so delivery is a queue plus a waiter: `next()` resolves
 * immediately if something is queued, and otherwise parks until an event
 * arrives or the subscription closes.
 */
class Subscriber {
   private readonly queue: Event[] = [];
   private readonly capacity: number;
   private waiter: ((event: Event | null) => void) | null = null;
   private closed = false;

   constructor(capacity: number) {
      this.capacity = capacity;
   }

   /** False when the buffer is full: the caller then drops this subscriber. */
   offer(event: Event): boolean {
      if (this.closed) return false;
      if (this.waiter) {
         const resolve = this.waiter;
         this.waiter = null;
         resolve(event);
         return true;
      }
      if (this.queue.length >= this.capacity) return false;
      this.queue.push(event);
      return true;
   }

   next(): Promise<Event | null> {
      if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
      if (this.closed) return Promise.resolve(null);
      return new Promise((resolve) => {
         this.waiter = resolve;
      });
   }

   stop(): void {
      if (this.closed) return;
      this.closed = true;
      this.queue.length = 0;
      if (this.waiter) {
         const resolve = this.waiter;
         this.waiter = null;
         resolve(null);
      }
   }
}

/** One subscription, with an idempotent close. */
export class Subscription {
   private readonly subscriber: Subscriber;
   private readonly onClose: () => void;
   private closed = false;

   constructor(subscriber: Subscriber, onClose: () => void) {
      this.subscriber = subscriber;
      this.onClose = onClose;
   }

   /** Resolves null once the subscription is closed. */
   next(): Promise<Event | null> {
      return this.subscriber.next();
   }

   /** Iterates until close, so a caller can `for await` over the stream. */
   async *events(): AsyncGenerator<Event> {
      for (;;) {
         const event = await this.next();
         if (event === null) return;
         yield event;
      }
   }

   close(): void {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
   }
}

export interface Broadcaster {
   publish(event: Event): Promise<void>;
   subscribe(workspaceId: string): Promise<Subscription>;
}

export class Hub implements Broadcaster {
   private readonly buffer: number;
   private readonly channels = new Map<string, Map<number, Subscriber>>();
   private nextId = 0;
   private closed = false;
   private overflow = 0;
   private observer: Observer | undefined;

   constructor(buffer: number) {
      if (!Number.isInteger(buffer) || buffer <= 0) {
         throw new Error('realtime subscriber buffer must be positive');
      }
      this.buffer = buffer;
   }

   setObserver(observer: Observer | undefined): void {
      this.observer = observer;
   }

   async subscribe(workspaceId: string): Promise<Subscription> {
      if (this.closed) throw new Error('realtime hub is closed');
      if (!workspaceId || workspaceId.trim() !== workspaceId) {
         throw new Error('valid workspace scope is required');
      }

      this.nextId += 1;
      const id = this.nextId;
      const subscriber = new Subscriber(this.buffer);
      let scope = this.channels.get(workspaceId);
      if (!scope) {
         scope = new Map();
         this.channels.set(workspaceId, scope);
      }
      scope.set(id, subscriber);

      return new Subscription(subscriber, () => this.remove(workspaceId, id));
   }

   /**
    * Fans an event out without ever blocking.
    *
    * A subscriber whose buffer is full is removed and its stream closed. It
    * will reconnect and refetch; the alternative is holding an event for it
    * while every other subscriber waits.
    */
   async publish(event: Event): Promise<void> {
      if (this.closed) throw new Error('realtime hub is closed');
      const normalized = normalizeEvent(event);

      let overflowed = 0;
      for (const scopeKey of eventScopes(normalized)) {
         const scope = this.channels.get(scopeKey);
         if (!scope) continue;
         for (const [id, subscriber] of scope) {
            if (!subscriber.offer(normalized)) {
               scope.delete(id);
               subscriber.stop();
               this.overflow += 1;
               overflowed += 1;
            }
         }
         if (scope.size === 0) this.channels.delete(scopeKey);
      }
      for (let index = 0; index < overflowed; index += 1) {
         this.observer?.({ kind: 'slowSubscriber' });
      }
   }

   /**
    * Ends every subscription without closing the hub.
    *
    * Used after the relay reconnects: the in-memory cursor only survives a
    * short gap, and stream trimming may have dropped an event nobody saw — so
    * clients are told to resync rather than left believing they are current.
    */
   disconnectAll(): void {
      for (const [scopeKey, scope] of this.channels) {
         for (const [id, subscriber] of scope) {
            scope.delete(id);
            subscriber.stop();
         }
         this.channels.delete(scopeKey);
      }
   }

   close(): void {
      if (this.closed) return;
      this.closed = true;
      this.disconnectAll();
   }

   subscriberCount(): number {
      let total = 0;
      for (const scope of this.channels.values()) total += scope.size;
      return total;
   }

   /** Disconnected slow subscribers, for metrics. */
   overflowCount(): number {
      return this.overflow;
   }

   private remove(workspaceId: string, id: number): void {
      const scope = this.channels.get(workspaceId);
      const subscriber = scope?.get(id);
      if (!scope || !subscriber) return;
      scope.delete(id);
      subscriber.stop();
      if (scope.size === 0) this.channels.delete(workspaceId);
   }
}
