import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleEnvelope } from './envelope.test.ts';
import { encodeLifecycle, type LifecycleEvent } from './lifecycle.ts';
import { httpTransport } from './http-transport.ts';
import { RuntimeUnavailable, type RuntimeTarget } from './transport.ts';

const target: RuntimeTarget = { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://agent-runtime:8080/' };

test('invoke posts to /invocations with the AgentCore session header', async () => {
   const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
   const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(encodeLifecycle({ type: 'task.started' }), { headers: { 'content-type': 'text/event-stream' } });
   }) as unknown as typeof fetch;
   const envelope = sampleEnvelope();
   const events: LifecycleEvent[] = [];
   for await (const e of httpTransport({ fetch: fakeFetch }).invoke({ target, envelope, signal: new AbortController().signal })) events.push(e);
   assert.equal(seen[0]!.url, 'http://agent-runtime:8080/invocations');
   assert.equal(new Headers(seen[0]!.init?.headers).get('x-amzn-bedrock-agentcore-runtime-session-id'), envelope.runtimeSessionId);
   assert.deepEqual(events, [{ type: 'task.started' }]);
});

test('a runtime that answers an error status is unavailable', async () => {
   const fakeFetch = (async () => new Response('down', { status: 502 })) as unknown as typeof fetch;
   const iterate = async () => {
      for await (const _ of httpTransport({ fetch: fakeFetch }).invoke({ target, envelope: sampleEnvelope(), signal: new AbortController().signal })) {
         // drain
      }
   };
   await assert.rejects(iterate, RuntimeUnavailable);
});

test('stop deletes the local session', async () => {
   const seen: string[] = [];
   const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url}`);
      return new Response(null, { status: 204 });
   }) as unknown as typeof fetch;
   await httpTransport({ fetch: fakeFetch }).stop({ target, runtimeSessionId: 'berry-x' });
   assert.deepEqual(seen, ['DELETE http://agent-runtime:8080/sessions/berry-x']);
});
