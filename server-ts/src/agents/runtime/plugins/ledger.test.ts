import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { RunTerminal } from '../../../runs/ledger.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { LedgerPlugin, type LedgerSink } from './ledger.ts';

/**
 * What the run stream reads. The order is the product: a person watching a
 * run sees the agent say something, then call something, then the call end,
 * then the answer. A ledger written in any other order shows a tool finishing
 * before it started.
 */

function fakeLedger() {
   const rows: string[] = [];
   const ledger: LedgerSink = {
      async appendToolStarted(_runId, id, name) {
         rows.push(`started:${name}:${id}`);
      },
      async appendToolCompleted(_runId, id, ok) {
         rows.push(`completed:${id}:${ok ? 'ok' : 'failed'}`);
      },
      async appendOutput(_runId, channel, text) {
         rows.push(`${channel}:${text}`);
      },
   };
   return { rows, ledger };
}

const echo = tool({
   name: 'echo',
   description: 'echo',
   inputSchema: z.object({ text: z.string() }),
   callback: async ({ text }) => ({ text }),
});

const broken = tool({
   name: 'broken',
   description: 'throws',
   inputSchema: z.object({}),
   callback: async () => {
      throw new Error('storage is down');
   },
});

test('text, then the tool, then its end, then the answer', async () => {
   const { rows, ledger } = fakeLedger();
   const model = new ScriptedModel([call('echo', { text: 'hi' }), say('All done here.')]);
   const agent = new Agent({
      model,
      tools: [echo],
      plugins: [new LedgerPlugin({ ledger, runId: 'run' })],
      printer: false,
   });

   await agent.invoke('go');

   assert.deepEqual(rows, [
      'started:echo:call_1',
      'completed:call_1:ok',
      'progress:All done here.',
   ]);
});

test('a tool that throws is recorded as failed, and the run goes on', async () => {
   const { rows, ledger } = fakeLedger();
   const model = new ScriptedModel([call('broken', {}), say('I could not save it.')]);
   const agent = new Agent({
      model,
      tools: [broken],
      plugins: [new LedgerPlugin({ ledger, runId: 'run' })],
      printer: false,
   });

   const result = await agent.invoke('go');

   assert.equal(result.stopReason, 'endTurn');
   assert.ok(rows.includes('completed:call_1:failed'));
});

test('a run that went terminal stops the plugin writing, without throwing', async () => {
   const rows: string[] = [];
   const ledger: LedgerSink = {
      async appendToolStarted() {
         throw new RunTerminal();
      },
      async appendToolCompleted() {
         rows.push('completed');
      },
      async appendOutput() {
         rows.push('output');
      },
   };
   const model = new ScriptedModel([call('echo', { text: 'x' }), say('late words')]);
   const agent = new Agent({
      model,
      tools: [echo],
      plugins: [new LedgerPlugin({ ledger, runId: 'run' })],
      printer: false,
   });

   await agent.invoke('go');

   assert.deepEqual(rows, [], 'nothing is written after the ledger refused');
});
