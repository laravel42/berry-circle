import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBerryEvents } from './translate.ts';

/**
 * The translation is the seam's load-bearing half, and it is pure, so it is
 * the one part of this worker that can be checked without a container.
 */

function sequencer(): () => number {
   let seq = 0;
   return () => seq++;
}

test('a completion becomes an exit carrying the code', () => {
   assert.deepEqual(toBerryEvents({ type: 'complete', exitCode: 0 }, 'pnpm test', sequencer()), [
      { type: 'exit', seq: 0, exitCode: 0 },
   ]);
   assert.deepEqual(toBerryEvents({ type: 'complete', exitCode: 1 }, 'pnpm test', sequencer()), [
      { type: 'exit', seq: 0, exitCode: 1 },
   ]);
});

test('a completion with no exit code is an error, never a success', () => {
   // Defaulting to zero here is how a failed run gets approved and merged.
   const [event] = toBerryEvents({ type: 'complete' }, 'pnpm test', sequencer());
   assert.equal(event?.type, 'error');
});

test('the command is carried onto start, and falls back to the one we asked for', () => {
   assert.deepEqual(toBerryEvents({ type: 'start' }, 'pnpm test', sequencer()), [
      { type: 'start', seq: 0, command: 'pnpm test' },
   ]);
   assert.deepEqual(
      toBerryEvents({ type: 'start', command: 'sh -c "pnpm test"' }, 'pnpm test', sequencer()),
      [{ type: 'start', seq: 0, command: 'sh -c "pnpm test"' }]
   );
});

test('output arrives on the stream it was written to', () => {
   assert.deepEqual(toBerryEvents({ type: 'stdout', data: '84 passed' }, 'x', sequencer()), [
      { type: 'stdout', seq: 0, data: '84 passed' },
   ]);
   assert.deepEqual(toBerryEvents({ type: 'stderr', data: 'warn' }, 'x', sequencer()), [
      { type: 'stderr', seq: 0, data: 'warn' },
   ]);
});

test('an empty chunk is not a ledger row', () => {
   assert.deepEqual(toBerryEvents({ type: 'stdout', data: '' }, 'x', sequencer()), []);
});

test('an error keeps its message, and always has one', () => {
   assert.deepEqual(toBerryEvents({ type: 'error', error: 'OOM killed' }, 'x', sequencer()), [
      { type: 'error', seq: 0, message: 'OOM killed' },
   ]);
   const [fallback] = toBerryEvents({ type: 'error' }, 'x', sequencer());
   assert.equal(fallback?.type, 'error');
   assert.match((fallback as { message: string }).message, /no message/);
});

test('an unknown event is dropped rather than failing the run', () => {
   assert.deepEqual(toBerryEvents({ type: 'heartbeat' }, 'x', sequencer()), []);
   assert.deepEqual(toBerryEvents(null, 'x', sequencer()), []);
   assert.deepEqual(toBerryEvents('nonsense', 'x', sequencer()), []);
});

test('sequence numbers advance across a whole stream', () => {
   const next = sequencer();
   const events = [
      ...toBerryEvents({ type: 'start' }, 'pnpm test', next),
      ...toBerryEvents({ type: 'stdout', data: 'a' }, 'pnpm test', next),
      ...toBerryEvents({ type: 'stdout', data: 'b' }, 'pnpm test', next),
      ...toBerryEvents({ type: 'complete', exitCode: 0 }, 'pnpm test', next),
   ];
   assert.deepEqual(
      events.map((event) => event.seq),
      [0, 1, 2, 3]
   );
});
