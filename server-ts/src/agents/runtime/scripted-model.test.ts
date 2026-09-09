import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ScriptedModel, call, say, throwing } from './scripted-model.ts';

/**
 * The double that makes the agent loop testable without Bedrock. What is
 * pinned is that a real `Agent` accepts it: a scripted tool call reaches a
 * real tool, and the scripted answer is the result.
 */

test('a scripted tool call reaches the tool and the answer is the result', async () => {
   const seen: string[] = [];
   const echo = tool({
      name: 'echo',
      description: 'echo',
      inputSchema: z.object({ text: z.string() }),
      callback: async ({ text }) => {
         seen.push(text);
         return { text };
      },
   });
   const model = new ScriptedModel([call('echo', { text: 'hi' }), say('done')]);
   const agent = new Agent({ model, tools: [echo], printer: false });

   const result = await agent.invoke('go');

   assert.deepEqual(seen, ['hi']);
   assert.equal(result.stopReason, 'endTurn');
   assert.equal(model.calls, 2);
   assert.equal(result.metrics?.accumulatedUsage.inputTokens, 20);
   // The second call saw the tool result the first one asked for.
   assert.equal(model.received[1]?.length, 3);
});

test('a scripted error is thrown from the model call', async () => {
   const model = new ScriptedModel([throwing(new Error('boom'))]);
   const agent = new Agent({ model, retryStrategy: null, printer: false });
   await assert.rejects(agent.invoke('go'), /boom/);
});

test('running past the script is an error, not silence', async () => {
   const model = new ScriptedModel([]);
   const agent = new Agent({ model, retryStrategy: null, printer: false });
   await assert.rejects(agent.invoke('go'), /script exhausted/);
});
