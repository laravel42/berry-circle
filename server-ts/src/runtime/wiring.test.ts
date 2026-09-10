import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueueTask } from '../runs/queue.ts';
import { quickActionEnqueue } from './wiring.ts';

/**
 * Each seam carries the runtime's real function. The types are proven by the
 * compiler (wiring.ts is typed with every seam); this pins the values, so a
 * seam cannot quietly go back to a fake or to null.
 */

test('quick actions queue through the runtime task queue', () => {
   assert.equal(quickActionEnqueue, enqueueTask);
});
