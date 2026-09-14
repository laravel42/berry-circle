import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
   SourceControlAuthenticationError,
   SourceControlConflictError,
   SourceControlError,
   SourceControlNotFoundError,
   SourceControlRateLimitError,
} from './errors.ts';
import { AgentCoreGatewayClient, type GatewayCall } from './gateway-client.ts';

/**
 * The MCP transport, against a fake gateway.
 *
 * These cover the parts that are the transport's job rather than GitHub's:
 * the JSON-RPC envelope, SSE framing, retry policy, error normalisation and
 * that credentials never reach the observer.
 */

function gateway(
   responses: Array<{ status?: number; body?: unknown; text?: string; headers?: Record<string, string> }>,
   options: { observe?: (call: GatewayCall) => void } = {}
) {
   const requests: Array<{ method: string; params: unknown; headers: Record<string, string> }> = [];
   let next = 0;
   const fake = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown };
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
         headers[key] = value;
      });
      requests.push({ method: body.method, params: body.params, headers });

      const entry = responses[next++] ?? { status: 200, body: { result: {} } };
      const text = entry.text ?? JSON.stringify(entry.body ?? { result: {} });
      return new Response(text, {
         status: entry.status ?? 200,
         headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
      });
   }) as unknown as typeof globalThis.fetch;

   return {
      requests,
      client: new AgentCoreGatewayClient({
         url: 'https://gateway.example/mcp',
         authorize: async () => ({ authorization: 'Bearer workload-token' }),
         fetch: fake,
         sleep: async () => undefined,
         ...(options.observe ? { observe: options.observe } : {}),
      }),
   };
}

test('a session is opened before the first call', async () => {
   const g = gateway([{ body: { result: {} } }, { body: { result: { tools: [] } } }]);
   await g.client.listTools();
   assert.equal(g.requests[0]?.method, 'initialize');
   assert.equal(g.requests[1]?.method, 'tools/list');
});

test('tools are listed across pages', async () => {
   const g = gateway([
      { body: { result: {} } },
      { body: { result: { tools: [{ name: 'a' }], nextCursor: 'c1' } } },
      { body: { result: { tools: [{ name: 'b' }] } } },
   ]);
   const tools = await g.client.listTools();
   assert.deepEqual(tools.map((t) => t.name), ['a', 'b']);
});

test('a tool result is parsed from its text content', async () => {
   const g = gateway([
      { body: { result: {} } },
      { body: { result: { content: [{ type: 'text', text: '{"number":7}' }] } } },
   ]);
   assert.deepEqual(await g.client.callTool('create_issue', {}), { number: 7 });
});

test('structured output wins over text when a tool provides both', async () => {
   const g = gateway([
      { body: { result: {} } },
      { body: { result: { structuredContent: { number: 9 }, content: [{ type: 'text', text: 'ignored' }] } } },
   ]);
   assert.deepEqual(await g.client.callTool('t', {}), { number: 9 });
});

test('a tool reporting isError is an error, not a result to remember to check', async () => {
   const g = gateway([
      { body: { result: {} } },
      { body: { result: { isError: true, content: [{ type: 'text', text: 'no such repo' }] } } },
   ]);
   await assert.rejects(g.client.callTool('t', {}), /no such repo/);
});

test('an SSE-framed response is read like a JSON one', async () => {
   // Streamable HTTP allows either for a single call.
   const g = gateway([
      { body: { result: {} } },
      { text: 'event: message\ndata: {"jsonrpc":"2.0","result":{"structuredContent":{"ok":true}}}\n\n' },
   ]);
   assert.deepEqual(await g.client.callTool('t', {}), { ok: true });
});

test('HTTP statuses become Berry errors', async () => {
   for (const [status, expected] of [
      [401, SourceControlAuthenticationError],
      [404, SourceControlNotFoundError],
      [409, SourceControlConflictError],
   ] as const) {
      const g = gateway([{ body: { result: {} } }, { status, text: 'nope' }]);
      await assert.rejects(g.client.callTool('t', {}), expected);
   }
});

test('a JSON-RPC method-not-found is a missing tool, not a retry', async () => {
   const g = gateway([
      { body: { result: {} } },
      { body: { jsonrpc: '2.0', error: { code: -32601, message: 'unknown tool' } } },
   ]);
   await assert.rejects(g.client.callTool('nope', {}), (error: SourceControlError) => {
      assert.equal(error.kind, 'not_found');
      assert.equal(error.retryable, false);
      return true;
   });
});

test('a rate limit is retried and then succeeds', async () => {
   const g = gateway([
      { body: { result: {} } },
      { status: 429, text: 'slow down' },
      { body: { result: { structuredContent: { ok: true } } } },
   ]);
   assert.deepEqual(await g.client.callTool('t', {}), { ok: true });
});

test('a conflict is never retried, because a duplicate is the one failure retrying worsens', async () => {
   const g = gateway([{ body: { result: {} } }, { status: 409, text: 'already exists' }]);
   await assert.rejects(g.client.callTool('t', {}), SourceControlConflictError);
   // initialize + one attempt, and no more.
   assert.equal(g.requests.length, 2);
});

test('retries give up and report the last failure', async () => {
   const g = gateway([
      { body: { result: {} } },
      { status: 503, text: 'down' },
      { status: 503, text: 'down' },
      { status: 503, text: 'down' },
   ]);
   await assert.rejects(g.client.callTool('t', {}), (error: SourceControlError) => {
      assert.equal(error.kind, 'gateway_unavailable');
      return true;
   });
});

test('a rate limit carries retry-after when the gateway sends it', async () => {
   const g = gateway([
      { body: { result: {} } },
      { status: 429, text: 'slow', headers: { 'retry-after': '2' } },
      { status: 429, text: 'slow', headers: { 'retry-after': '2' } },
      { status: 429, text: 'slow', headers: { 'retry-after': '2' } },
   ]);
   await assert.rejects(g.client.callTool('t', {}), (error: SourceControlRateLimitError) => {
      assert.equal(error.retryAfterMs, 2000);
      return true;
   });
});

test('the observer sees the call but never the credential or arguments', async () => {
   const seen: GatewayCall[] = [];
   const g = gateway(
      [{ body: { result: {} } }, { body: { result: { structuredContent: {} } } }],
      { observe: (call) => seen.push(call) }
   );
   await g.client.callTool('create_issue', { title: 'secret-ish title' });

   const call = seen.find((c) => c.method === 'tools/call');
   assert.equal(call?.tool, 'create_issue');
   assert.equal(call?.ok, true);
   const serialized = JSON.stringify(seen);
   assert.ok(!serialized.includes('workload-token'), 'no credential may reach the log');
   assert.ok(!serialized.includes('secret-ish'), 'no arguments may reach the log');
});

test('the gateway request id is carried for correlating with AWS logs', async () => {
   const g = gateway([
      { body: { result: {} } },
      { status: 500, text: 'boom', headers: { 'x-amzn-requestid': 'req-abc' } },
      { status: 500, text: 'boom', headers: { 'x-amzn-requestid': 'req-abc' } },
      { status: 500, text: 'boom', headers: { 'x-amzn-requestid': 'req-abc' } },
   ]);
   await assert.rejects(g.client.callTool('t', {}), (error: SourceControlError) => {
      assert.equal(error.requestId, 'req-abc');
      return true;
   });
});
