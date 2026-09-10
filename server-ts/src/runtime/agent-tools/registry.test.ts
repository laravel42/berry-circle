import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { AgentToolConflict, getAgentTool, listAgentTools, registerAgentTool } from './registry.ts';

test('a registered tool is listed with a JSON schema for its input', () => {
   registerAgentTool('registry_probe', {
      description: 'probe',
      scope: 'task:read',
      inputSchema: z.object({ n: z.number() }),
      handler: async (_context, input) => ({ doubled: input.n * 2 }),
   });
   const listed = listAgentTools().find((tool) => tool.name === 'registry_probe');
   assert.ok(listed);
   assert.equal((listed.jsonSchema as { type?: string }).type, 'object');
});

test('a second tool with the same name is refused', () => {
   const def = { description: 'x', scope: 'task:read' as const, inputSchema: z.object({}), handler: async () => null };
   registerAgentTool('registry_dupe', def);
   assert.throws(() => registerAgentTool('registry_dupe', def), AgentToolConflict);
});

test('a tool name the model could not call is refused', () => {
   const def = { description: 'x', scope: 'task:read' as const, inputSchema: z.object({}), handler: async () => null };
   assert.throws(() => registerAgentTool('Bad Name', def), /tool name/);
});

test('input is validated before the handler sees it', async () => {
   registerAgentTool('registry_validate', {
      description: 'v',
      scope: 'task:read',
      inputSchema: z.object({ n: z.number() }),
      handler: async (_context, input) => input.n,
   });
   const tool = getAgentTool('registry_validate');
   assert.ok(tool);
   const refused = await tool.run({} as never, { n: 'x' });
   assert.equal(refused.ok, false);
   const ran = await tool.run({} as never, { n: 2 });
   assert.deepEqual(ran, { ok: true, result: 2 });
});
