import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTOPILOT_TOPICS } from '../autopilots/events.ts';
import { WORKSPACE_TOPICS } from './replay.ts';

test('every autopilot fact reaches the workspace stream', () => {
   // The replay matches topics exactly: a topic missing from the list is a
   // fact that is written and never arrives.
   for (const topic of AUTOPILOT_TOPICS) {
      assert.ok((WORKSPACE_TOPICS as readonly string[]).includes(topic), topic);
   }
});
