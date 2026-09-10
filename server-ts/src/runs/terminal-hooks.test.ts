import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from './ledger.ts';
import { notifyRunTerminal, onRunTerminal } from './terminal-hooks.ts';

const run = { id: 'r1', status: 'succeeded' } as unknown as Run;

test('every registered hook sees a finished run, in registration order', async () => {
   const seen: string[] = [];
   const offA = onRunTerminal(async (r) => void seen.push(`a:${r.id}`));
   const offB = onRunTerminal(async (r) => void seen.push(`b:${r.id}`));
   await notifyRunTerminal(run);
   offA();
   offB();
   assert.deepEqual(seen, ['a:r1', 'b:r1']);
});

test('a failing hook is reported and does not stop the next one', async () => {
   const seen: string[] = [];
   const errors: unknown[] = [];
   const offA = onRunTerminal(async () => {
      throw new Error('boom');
   });
   const offB = onRunTerminal(async () => void seen.push('b'));
   await notifyRunTerminal(run, (error) => errors.push(error));
   offA();
   offB();
   assert.deepEqual(seen, ['b']);
   assert.equal(errors.length, 1);
});

test('an unsubscribed hook is not called', async () => {
   let called = false;
   const off = onRunTerminal(async () => {
      called = true;
   });
   off();
   await notifyRunTerminal(run);
   assert.equal(called, false);
});
