import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Distributed } from './distributed.ts';
import { Hub, type Observation } from './hub.ts';
import type { Relay } from './relay.ts';
import type { Event } from './event.ts';

function event(overrides: Partial<Event> = {}): Event {
   return {
      id: 'evt-1',
      workspaceId: 'ws-1',
      type: 'issue.updated',
      payload: '{"a":1}',
      occurredAt: new Date('2026-08-27T06:30:00Z'),
      ...overrides,
   };
}

/** A relay that records what it was asked to publish and can be made to fail. */
class FakeRelay implements Relay {
   readonly nodeId = 'node-local';
   readonly published: Event[] = [];
   failing = false;

   async publish(value: Event): Promise<void> {
      if (this.failing) throw new Error('relay unavailable');
      this.published.push(value);
   }
   async run(_receive: unknown, signal: AbortSignal): Promise<void> {
      await new Promise<void>((resolve) => {
         if (signal.aborted) return resolve();
         signal.addEventListener('abort', () => resolve(), { once: true });
      });
   }
   async ping(): Promise<void> {}
   async prepare(): Promise<void> {}
   async close(): Promise<void> {}
}

test('publishing delivers locally and forwards to the relay', async () => {
   const hub = new Hub(4);
   const relay = new FakeRelay();
   const broadcaster = new Distributed(hub, relay);
   const subscription = await broadcaster.subscribe('ws-1');

   await broadcaster.publish(event({ id: 'a' }));

   assert.equal((await subscription.next())?.id, 'a');
   assert.equal(relay.published.length, 1);
});

test('the same event arriving twice is delivered once', async () => {
   // An event published here comes back off the relay. Delivering both would
   // show every action twice.
   const hub = new Hub(4);
   const broadcaster = new Distributed(hub, new FakeRelay());
   const subscription = await broadcaster.subscribe('ws-1');

   await broadcaster.publish(event({ id: 'a' }));
   await broadcaster.publish(event({ id: 'a' }));

   assert.equal((await subscription.next())?.id, 'a');
   // Nothing further is waiting: a second delivery would resolve immediately.
   const second = await Promise.race([
      subscription.next(),
      new Promise((resolve) => setTimeout(() => resolve('nothing'), 50)),
   ]);
   assert.equal(second, 'nothing');
});

test('a relay failure degrades rather than failing the write', async () => {
   // Local subscribers already have the event and the fact is in PostgreSQL,
   // so a relay outage costs other nodes their live update, not the write.
   const observed: Observation[] = [];
   const hub = new Hub(4);
   const relay = new FakeRelay();
   relay.failing = true;
   const broadcaster = new Distributed(hub, relay, { observer: (o) => observed.push(o) });
   const subscription = await broadcaster.subscribe('ws-1');

   await broadcaster.publish(event({ id: 'a' }));

   assert.equal((await subscription.next())?.id, 'a', 'local delivery still happened');
   assert.ok(observed.some((o) => o.kind === 'relayPublishFailed'));
   assert.equal(broadcaster.isHealthy(), false);
});

test('a required relay failure does fail the write', async () => {
   const relay = new FakeRelay();
   relay.failing = true;
   const broadcaster = new Distributed(new Hub(4), relay, { required: true });
   await assert.rejects(() => broadcaster.publish(event({ id: 'a' })), /relay unavailable/);
});

test('a broadcaster with no relay is healthy and still delivers', async () => {
   const hub = new Hub(4);
   const broadcaster = new Distributed(hub, null);
   const subscription = await broadcaster.subscribe('ws-1');

   assert.equal(broadcaster.isHealthy(), true);
   await broadcaster.publish(event({ id: 'a' }));
   assert.equal((await subscription.next())?.id, 'a');
});

test('a required broadcaster cannot be built without a relay', () => {
   assert.throws(() => new Distributed(new Hub(4), null, { required: true }), /unavailable/);
});

test('dedupe bounds are validated', () => {
   const hub = new Hub(4);
   assert.throws(() => new Distributed(hub, null, { dedupeEntries: 0 }), /capacity/);
   assert.throws(() => new Distributed(hub, null, { dedupeEntries: 2_000_000 }), /capacity/);
   assert.throws(() => new Distributed(hub, null, { dedupeTtlMs: 10 }), /TTL/);
   assert.throws(() => new Distributed(hub, null, { dedupeTtlMs: 48 * 3600_000 }), /TTL/);
});

test('the deduper forgets the oldest ids rather than growing', async () => {
   // Bounded by count as well as age: a process that ran for a week would
   // otherwise hold every event id it had ever seen.
   const hub = new Hub(64);
   const broadcaster = new Distributed(hub, null, { dedupeEntries: 2 });
   const subscription = await broadcaster.subscribe('ws-1');

   await broadcaster.publish(event({ id: 'a' }));
   await broadcaster.publish(event({ id: 'b' }));
   await broadcaster.publish(event({ id: 'c' })); // evicts a
   await broadcaster.publish(event({ id: 'a' })); // no longer a duplicate

   const seen: string[] = [];
   for (let index = 0; index < 4; index += 1) {
      const received = await subscription.next();
      if (received) seen.push(received.id);
   }
   assert.deepEqual(seen, ['a', 'b', 'c', 'a']);
});

test('a failed local publish releases the id for a retry', async () => {
   // Otherwise the retry would be treated as a duplicate and silently dropped.
   const hub = new Hub(4);
   const broadcaster = new Distributed(hub, null);
   hub.close();

   await assert.rejects(() => broadcaster.publish(event({ id: 'a' })));
   // A fresh hub, same broadcaster: the id must not still be remembered.
   const second = new Distributed(new Hub(4), null);
   const subscription = await second.subscribe('ws-1');
   await second.publish(event({ id: 'a' }));
   assert.equal((await subscription.next())?.id, 'a');
});
