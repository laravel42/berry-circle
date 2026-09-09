import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { ToolFailed, ToolOutcomePlugin } from './tool-outcome.ts';

/**
 * A tool that throws is a result with an error status to the SDK, so the run
 * goes on and can still report success. For most tools that is right: a
 * non-zero `pnpm test` is a result the model must act on. For `write_file` it
 * is a false success — the ledger shows a failed tool and the run shows done
 * while the file was never saved (F-23). The policy is a table, in one place.
 */

const writeFile = tool({
   name: 'write_file',
   description: 'save',
   inputSchema: z.object({ path: z.string() }),
   callback: async () => {
      throw new Error('storage is down');
   },
});
const runCommand = tool({
   name: 'run_command',
   description: 'run',
   inputSchema: z.object({ command: z.string() }),
   callback: async () => {
      throw new Error('substrate exploded');
   },
});

test('a thrown write_file makes the run fatal', async () => {
   const model = new ScriptedModel([call('write_file', { path: 'a.md' }), say('saved!')]);
   const outcome = new ToolOutcomePlugin();
   const agent = new Agent({ model, tools: [writeFile], plugins: [outcome], printer: false });
   await agent.invoke('go');
   const fatal = outcome.fatal();
   assert.ok(fatal instanceof ToolFailed);
   assert.equal(fatal.code, 'TOOL_FAILED');
   assert.equal(fatal.tool, 'write_file');
   assert.match(fatal.message, /storage is down/);
});

test('a thrown run_command is reported to the model and is not fatal', async () => {
   const model = new ScriptedModel([call('run_command', { command: 'x' }), say('it broke')]);
   const outcome = new ToolOutcomePlugin();
   const agent = new Agent({ model, tools: [runCommand], plugins: [outcome], printer: false });
   await agent.invoke('go');
   assert.equal(outcome.fatal(), null);
   assert.equal(outcome.failures.length, 1);
});
