import assert from 'node:assert/strict';
import { test } from 'node:test';
import { usageRecordFor } from './in-process.ts';

const RUN = {
   runId: '00000000-0000-4000-8000-000000000001',
   workspaceId: '00000000-0000-4000-8000-000000000002',
   agentId: '00000000-0000-4000-8000-000000000003',
   model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
};

function snapshot(input: number, output: number, cacheRead = 0, cacheWrite = 0, modelCalls = 1) {
   return {
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, costMicros: null, currency: null },
      modelCalls,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
   };
}

test('a run that never called the model records nothing', () => {
   assert.equal(usageRecordFor(RUN, snapshot(0, 0, 0, 0, 0)), null);
});

test('a run that called the model records every token kind against its agent and model', () => {
   assert.deepEqual(usageRecordFor(RUN, snapshot(120, 15, 1900, 50)), {
      ...RUN,
      inputTokens: 120,
      outputTokens: 15,
      cacheReadTokens: 1900,
      cacheWriteTokens: 50,
   });
});
