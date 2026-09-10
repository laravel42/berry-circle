import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { sampleEnvelope } from '../../../runtime/envelope.test.ts';
import { parseLifecycleStream, type LifecycleEvent } from '../../../runtime/lifecycle.ts';
import { ScriptedModel, call, say } from '../scripted-model.ts';
import { createRuntimeServer } from './server.ts';
import { SessionRegistry } from './sessions.ts';

let release: () => void = () => {};
const gate = new Promise<void>((resolve) => {
   release = resolve;
});
const registry = new SessionRegistry();
const waitTool = tool({ name: 'wait', description: 'w', inputSchema: z.object({}), callback: async () => (await gate, 'ok') });
const server = createRuntimeServer({
   registry,
   // Each task builds its own model; the envelope's model id picks the script.
   modelFactory: (spec) =>
      new ScriptedModel(spec.model === 'wait' ? [call('wait', {}), say('late')] : [say('hello')]),
   region: 'us-east-1',
   workRoot: mkdtempSync(join(tmpdir(), 'berry-server-')),
   loadTools: async () => [waitTool],
   localControl: true,
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test('ping answers Healthy when idle', async () => {
   const body = (await (await fetch(`${base}/ping`)).json()) as { status: string };
   assert.equal(body.status, 'Healthy');
});

test('an invocation streams lifecycle events to a terminal event', async () => {
   const envelope = sampleEnvelope({ runtimeSessionId: `berry-${'1'.repeat(64)}` });
   const response = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': envelope.runtimeSessionId },
      body: JSON.stringify(envelope),
   });
   assert.equal(response.headers.get('content-type'), 'text/event-stream');
   const events: LifecycleEvent[] = [];
   for await (const event of parseLifecycleStream(response.body!)) events.push(event);
   assert.equal(events[0]!.type, 'task.started');
   assert.equal(events.at(-1)!.type, 'task.completed');
});

test('a session header that disagrees with the envelope is refused', async () => {
   const response = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-amzn-bedrock-agentcore-runtime-session-id': `berry-${'x'.repeat(64)}` },
      body: JSON.stringify(sampleEnvelope()),
   });
   assert.equal(response.status, 400);
});

test('an envelope that does not parse is a 400', async () => {
   const response = await fetch(`${base}/invocations`, { method: 'POST', body: '{"kind":"agent"}' });
   assert.equal(response.status, 400);
});

test('the loop outlives a closed stream, and ping says HealthyBusy meanwhile', async () => {
   // Not `base`: that name is the server URL at module scope.
   const sample = sampleEnvelope();
   const envelope = sampleEnvelope({ runtimeSessionId: `berry-${'2'.repeat(64)}`, agent: { ...sample.agent, model: 'wait' } });
   const controller = new AbortController();
   const response = await fetch(`${base}/invocations`, {
      method: 'POST', body: JSON.stringify(envelope), signal: controller.signal,
   });
   const reader = response.body!.getReader();
   await reader.read();
   controller.abort();
   await new Promise((resolve) => setTimeout(resolve, 100));
   const busy = (await (await fetch(`${base}/ping`)).json()) as { status: string };
   assert.equal(busy.status, 'HealthyBusy');
   release();
   for (let i = 0; i < 50 && registry.busy; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
   assert.equal(registry.busy, false);
   assert.ok(registry.get(envelope.runtimeSessionId), 'the session is kept warm');
});

test('local stop forgets a session', async () => {
   const response = await fetch(`${base}/sessions/berry-${'2'.repeat(64)}`, { method: 'DELETE' });
   assert.equal(response.status, 204);
});
