import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { AccountingPlugin } from './accounting.ts';

/**
 * What a run cost and what it said. Usage is summed across model calls
 * because an agent that called three tools made four model calls, and the
 * run paid for all of them. The result is the last substantive turn, which
 * `ResultText` already knows how to pick.
 */

const echo = tool({
   name: 'echo',
   description: 'echo',
   inputSchema: z.object({ text: z.string() }),
   callback: async ({ text }) => ({ text }),
});

test('usage is summed over every model call and matches the SDK', async () => {
   const model = new ScriptedModel([
      call('echo', { text: 'a' }, { inputTokens: 100, outputTokens: 10 }),
      call('echo', { text: 'b' }, { inputTokens: 200, outputTokens: 20 }),
      say('x'.repeat(500), { inputTokens: 300, outputTokens: 30 }),
   ]);
   const accounting = new AccountingPlugin();
   const agent = new Agent({ model, tools: [echo], plugins: [accounting], printer: false });

   const result = await agent.invoke('go');
   const snapshot = accounting.snapshot();

   assert.equal(snapshot.usage.inputTokens, 600);
   assert.equal(snapshot.usage.outputTokens, 60);
   assert.equal(snapshot.usage.totalTokens, 660);
   assert.equal(snapshot.usage.inputTokens, result.metrics?.accumulatedUsage.inputTokens);
   assert.equal(snapshot.toolCalls, 2);
   assert.equal(snapshot.modelCalls, 3);
});

test('the result is the substantive answer, not the sign-off', async () => {
   // A multi-turn result needs several assistant messages, which the scripted
   // model produces through tool calls: a thin remark, work, then the report.
   const long = 'The answer is 42 because ' + 'y'.repeat(400);
   const model = new ScriptedModel([call('echo', { text: 'a' }), say(long)]);
   const accounting = new AccountingPlugin();
   const agent = new Agent({ model, tools: [echo], plugins: [accounting], printer: false });
   await agent.invoke('go');
   assert.equal(accounting.snapshot().result.final()[0], long);
});

test('a turn that is only a tool call leaves the result empty', async () => {
   const model = new ScriptedModel([call('echo', { text: 'a' }), say('')]);
   const accounting = new AccountingPlugin();
   const agent = new Agent({ model, tools: [echo], plugins: [accounting], printer: false });
   await agent.invoke('go');
   assert.deepEqual(accounting.snapshot().result.final(), ['', false]);
});

test('cache reads and writes are counted apart from input', async () => {
   const model = new ScriptedModel([
      call('echo', { text: 'a' }, { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheWriteInputTokens: 50 }),
      say('done', { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 1000 }),
   ]);
   const accounting = new AccountingPlugin();
   const agent = new Agent({ model, tools: [echo], plugins: [accounting], printer: false });
   await agent.invoke('go');
   const snapshot = accounting.snapshot();
   assert.equal(snapshot.usage.inputTokens, 120);
   assert.equal(snapshot.cacheReadTokens, 1900);
   assert.equal(snapshot.cacheWriteTokens, 50);
});
