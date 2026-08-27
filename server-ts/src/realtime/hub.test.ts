import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hub, type Observation } from './hub.ts';
import { InvalidEvent, eventScopes, normalizeEvent, type Event } from './event.ts';

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

test('a subscriber receives events for its workspace', async () => {
   const hub = new Hub(4);
   const subscription = await hub.subscribe('ws-1');
   await hub.publish(event({ id: 'a' }));

   const received = await subscription.next();
   assert.equal(received?.id, 'a');
   subscription.close();
});

test('an event reaches both its workspace and its board', async () => {
   // One fact, two delivery scopes: board views subscribe on the board while
   // workspace-wide consumers subscribe on the workspace.
   const hub = new Hub(4);
   const workspace = await hub.subscribe('ws-1');
   const board = await hub.subscribe('board-1');
   await hub.publish(event({ id: 'a', boardId: 'board-1' }));

   assert.equal((await workspace.next())?.id, 'a');
   assert.equal((await board.next())?.id, 'a');
});

test('a subscriber on one scope sees the event once, not twice', () => {
   // A caller passing the same id for both fields must not double-deliver.
   assert.deepEqual(eventScopes(event({ boardId: 'ws-1' })), ['ws-1']);
   assert.deepEqual(eventScopes(event({ boardId: 'board-1' })), ['ws-1', 'board-1']);
   assert.deepEqual(eventScopes(event()), ['ws-1']);
});

test('a subscriber that stops reading is dropped, not buffered for', async () => {
   // The reason the hub is safe: an event is a projection of a fact already in
   // PostgreSQL, so a client that misses one refetches — whereas buffering for
   // a stalled browser would grow until the process died.
   const observed: Observation[] = [];
   const hub = new Hub(2);
   hub.setObserver((observation) => observed.push(observation));
   const subscription = await hub.subscribe('ws-1');

   await hub.publish(event({ id: 'a' }));
   await hub.publish(event({ id: 'b' }));
   assert.equal(hub.subscriberCount(), 1, 'still within its buffer');

   await hub.publish(event({ id: 'c' }));
   assert.equal(hub.subscriberCount(), 0, 'overflowed and removed');
   assert.equal(hub.overflowCount(), 1);
   assert.deepEqual(observed, [{ kind: 'slowSubscriber' }]);

   // Its stream ends rather than hanging, so the client reconnects.
   assert.equal(await subscription.next(), null);
});

test('a dropped subscriber does not stop the others', async () => {
   const hub = new Hub(1);
   const slow = await hub.subscribe('ws-1');
   const fast = await hub.subscribe('ws-1');

   await hub.publish(event({ id: 'a' }));
   assert.equal((await fast.next())?.id, 'a'); // fast drains its buffer
   await hub.publish(event({ id: 'b' })); // slow overflows here

   assert.equal(hub.subscriberCount(), 1);
   assert.equal((await fast.next())?.id, 'b');
   assert.equal(await slow.next(), null);
});

test('closing a subscription removes it', async () => {
   const hub = new Hub(4);
   const subscription = await hub.subscribe('ws-1');
   assert.equal(hub.subscriberCount(), 1);

   subscription.close();
   subscription.close(); // idempotent
   assert.equal(hub.subscriberCount(), 0);
});

test('disconnectAll ends subscriptions but keeps the hub usable', async () => {
   // Used after a relay reconnect: the cursor only survives a short gap, so
   // clients are told to resync rather than left believing they are current.
   const hub = new Hub(4);
   const first = await hub.subscribe('ws-1');
   hub.disconnectAll();
   assert.equal(await first.next(), null);
   assert.equal(hub.subscriberCount(), 0);

   const second = await hub.subscribe('ws-1');
   await hub.publish(event({ id: 'a' }));
   assert.equal((await second.next())?.id, 'a');
});

test('a closed hub accepts nothing further', async () => {
   const hub = new Hub(4);
   hub.close();
   await assert.rejects(() => hub.publish(event()), /closed/);
   await assert.rejects(() => hub.subscribe('ws-1'), /closed/);
});

test('an event is normalised before it is delivered', () => {
   const normalized = normalizeEvent({ ...event(), id: '', payload: undefined as unknown as string });
   assert.match(normalized.id, /^[0-9a-f-]{36}$/, 'a missing id becomes a uuid');
   assert.equal(normalized.payload, 'null', 'a missing payload is the JSON literal');
});

test('an invalid event is refused rather than delivered', () => {
   const cases: Array<[string, Partial<Event>]> = [
      ['no workspace', { workspaceId: '' }],
      ['workspace with a space', { workspaceId: 'ws 1' }],
      ['workspace with a slash', { workspaceId: 'ws/1' }],
      ['bad board', { boardId: 'board 1' }],
      ['no type', { type: '' }],
      ['type starting with a digit', { type: '1issue' }],
      ['uppercase type', { type: 'Issue.Updated' }],
      ['payload that is not JSON', { payload: '{oops' }],
      ['payload over 64KiB', { payload: JSON.stringify('x'.repeat(70 * 1024)) }],
   ];
   for (const [name, overrides] of cases) {
      assert.throws(() => normalizeEvent(event(overrides)), InvalidEvent, name);
   }
});

test('the buffer size must be positive', () => {
   assert.throws(() => new Hub(0), /positive/);
   assert.throws(() => new Hub(-1), /positive/);
});
