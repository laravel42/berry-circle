import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMcpClients, mcpServerConfigs } from './mcp-clients.ts';

test('each server becomes a prefixed, fail-soft MCP config with its transport', () => {
   assert.deepEqual(
      mcpServerConfigs([
         { name: 'docs', url: 'https://d.test/mcp', transport: 'http', headers: { A: '1' } },
         { name: 'old', url: 'https://o.test/sse', transport: 'sse', headers: {} },
      ]),
      {
         docs: {
            url: 'https://d.test/mcp',
            transport: 'streamable-http',
            headers: { A: '1' },
            prefix: 'docs',
            continueOnError: true,
         },
         old: { url: 'https://o.test/sse', transport: 'sse', headers: {}, prefix: 'old', continueOnError: true },
      }
   );
});

test('no servers means no clients and no connection attempt', async () => {
   assert.deepEqual(await loadMcpClients([]), []);
});
