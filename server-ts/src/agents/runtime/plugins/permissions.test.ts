import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { noPermissions, permissionsOf } from '../../permissions.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { PermissionPlugin } from './permissions.ts';

/**
 * Berry's claim about agents is that revoking a permission makes the runtime
 * refuse the call — not that it hides a button. This is the enforcement point:
 * one hook in front of every tool, checked on every call, and closed by
 * default. An unknown tool name grants nothing, and neither does a missing
 * permission set.
 */

let ran = 0;
const runCommand = tool({
   name: 'run_command',
   description: 'run',
   inputSchema: z.object({ command: z.string() }),
   callback: async () => {
      ran += 1;
      return { exitCode: 0 };
   },
});
const readTask = tool({
   name: 'read_task',
   description: 'read',
   inputSchema: z.object({}),
   callback: async () => ({ found: true }),
});
const mystery = tool({
   name: 'mystery',
   description: 'not in the table',
   inputSchema: z.object({}),
   callback: async () => {
      ran += 1;
      return 'ran';
   },
});

/** What the model was shown on its next call: the tool result. */
function received(model: ScriptedModel, index: number): string {
   const message = model.received[index]?.at(-1);
   return JSON.stringify(message ?? null);
}

test('a denied tool is refused with a sentence the model can read', async () => {
   ran = 0;
   const model = new ScriptedModel([call('run_command', { command: 'ls' }), say('I may not.')]);
   const agent = new Agent({
      model,
      tools: [runCommand],
      plugins: [new PermissionPlugin({ permissions: permissionsOf(['read_repository'], 'Bot') })],
      printer: false,
   });

   await agent.invoke('go');

   assert.equal(ran, 0);
   assert.match(received(model, 1), /Bot does not have permission to run commands/);
});

test('a granted tool runs', async () => {
   ran = 0;
   const model = new ScriptedModel([call('run_command', { command: 'ls' }), say('ok')]);
   const agent = new Agent({
      model,
      tools: [runCommand],
      plugins: [new PermissionPlugin({ permissions: permissionsOf(['run_commands'], 'Bot') })],
      printer: false,
   });
   await agent.invoke('go');
   assert.equal(ran, 1);
});

test('a tool with no permission in the table is open to any agent', async () => {
   const model = new ScriptedModel([call('read_task', {}), say('ok')]);
   const agent = new Agent({
      model,
      tools: [readTask],
      plugins: [new PermissionPlugin({ permissions: noPermissions('Bot') })],
      printer: false,
   });
   await agent.invoke('go');
   assert.doesNotMatch(received(model, 1), /permission/);
});

test('a tool the table has never heard of is refused, not allowed', async () => {
   ran = 0;
   const model = new ScriptedModel([call('mystery', {}), say('ok')]);
   const agent = new Agent({
      model,
      tools: [mystery],
      plugins: [new PermissionPlugin({ permissions: permissionsOf(['run_commands'], 'Bot') })],
      printer: false,
   });
   await agent.invoke('go');
   assert.equal(ran, 0);
   assert.match(received(model, 1), /not a tool this run offers/);
});
