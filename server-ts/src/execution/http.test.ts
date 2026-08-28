import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpDriver } from './http.ts';
import { encodeFrame } from './events.ts';
import { ExecutionFailed, ExecutionUnavailable, type ExecEvent } from './driver.ts';

/**
 * The driver against a stubbed substrate.
 *
 * These assert the contract both substrates have to keep — the request each
 * receives and the failure Berry sees — without a container, so they run in
 * the default offline suite. The same assertions hold for `runtime/` and
 * `runtime-worker/`, because the driver cannot tell them apart.
 */

interface Call {
   url: string;
   method: string;
   headers: Record<string, string>;
   body: unknown;
}

function stub(handler: (call: Call) => Response): {
   fetch: typeof globalThis.fetch;
   calls: Call[];
} {
   const calls: Call[] = [];
   const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(init?.headers ?? {})) {
         headers[key.toLowerCase()] = String(value);
      }
      const call: Call = {
         url: String(input),
         method: init?.method ?? 'GET',
         headers,
         body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
   }) as typeof globalThis.fetch;
   return { fetch, calls };
}

function json(value: unknown, status = 200): Response {
   return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
   });
}

function sse(events: ExecEvent[]): Response {
   return new Response(events.map(encodeFrame).join(''), {
      headers: { 'content-type': 'text/event-stream' },
   });
}

const OPTIONS = { baseUrl: 'https://runtime.example', token: 'secret-token' };

test('every request carries the bearer token', async () => {
   const { fetch, calls } = stub(() => json({ status: 'ok' }));
   await httpDriver({ ...OPTIONS, fetch }).health();
   assert.equal(calls[0]?.headers.authorization, 'Bearer secret-token');
});

test('a session is addressed by the run it belongs to', async () => {
   const { fetch, calls } = stub(() => json({ sessionId: 'run-1' }));
   const session = await httpDriver({ ...OPTIONS, fetch }).createSession({
      runId: 'run-1',
      cwd: '/workspace/repo',
      env: { CI: 'true' },
   });
   assert.equal(session.id, 'run-1');
   assert.equal(calls[0]?.url, 'https://runtime.example/sessions');
   assert.deepEqual(calls[0]?.body, {
      runId: 'run-1',
      cwd: '/workspace/repo',
      env: { CI: 'true' },
   });
});

test('a command reports its exit code rather than throwing on failure', async () => {
   // A failing test suite is a result, not an error. Only the substrate
   // breaking is an exception.
   const { fetch, calls } = stub((call) =>
      call.url.endsWith('/exec')
         ? json({ stdout: '', stderr: 'boom', exitCode: 1 })
         : json({ sessionId: 'r' })
   );
   const session = await httpDriver({ ...OPTIONS, fetch }).createSession({ runId: 'r' });
   assert.deepEqual(await session.exec('pnpm test', { cwd: '/workspace/repo', timeoutMs: 5000 }), {
      stdout: '',
      stderr: 'boom',
      exitCode: 1,
   });
   assert.equal(calls[1]?.url, 'https://runtime.example/sessions/r/exec');
   assert.deepEqual(calls[1]?.body, {
      command: 'pnpm test',
      cwd: '/workspace/repo',
      timeoutMs: 5000,
   });
});

test('a stream yields every event in order', async () => {
   const events: ExecEvent[] = [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: '84 passed' },
      { type: 'exit', seq: 2, exitCode: 0 },
   ];
   const { fetch } = stub((call) => (call.url.endsWith('/exec/stream') ? sse(events) : json({ sessionId: 'r' })));
   const driver = httpDriver({ ...OPTIONS, fetch });
   const session = await driver.createSession({ runId: 'r' });

   const seen: ExecEvent[] = [];
   for await (const event of session.stream('pnpm test')) seen.push(event);
   assert.deepEqual(seen, events);
});

test('a stream that stops before the exit is a failure, not a success', async () => {
   // The whole point: a truncated stream must never be read as a run that
   // finished, because the ledger would record a code that was never sent.
   const { fetch } = stub((call) =>
      call.url.endsWith('/exec/stream')
         ? sse([{ type: 'stdout', seq: 0, data: 'installing…' }])
         : json({ sessionId: 'r' })
   );
   const driver = httpDriver({ ...OPTIONS, fetch });
   const session = await driver.createSession({ runId: 'r' });

   await assert.rejects(async () => {
      for await (const _event of session.stream('pnpm install')) void _event;
   }, ExecutionFailed);
});

test('a substrate that is down is unavailable, not a failed run', async () => {
   const down = stub(() => json({ error: 'no capacity' }, 503));
   await assert.rejects(
      httpDriver({ ...OPTIONS, fetch: down.fetch }).health(),
      ExecutionUnavailable
   );

   const refused = stub(() => {
      throw new TypeError('fetch failed');
   });
   await assert.rejects(
      httpDriver({ ...OPTIONS, fetch: refused.fetch }).health(),
      ExecutionUnavailable
   );
});

test('a bad request is a failure the caller caused', async () => {
   const { fetch } = stub((call) =>
      call.url.endsWith('/sessions') ? json({ error: 'runId is required' }, 400) : json({})
   );
   await assert.rejects(
      httpDriver({ ...OPTIONS, fetch }).createSession({ runId: 'r' }),
      ExecutionFailed
   );
});

test('teardown tolerates a session the substrate has already forgotten', async () => {
   // destroy() runs on the failure path. A cleanup that throws would replace
   // the real reason a run failed with a complaint about tidying up.
   const { fetch } = stub((call) =>
      call.method === 'DELETE' ? json({ error: 'unknown session' }, 404) : json({ sessionId: 'r' })
   );
   const driver = httpDriver({ ...OPTIONS, fetch });
   const session = await driver.createSession({ runId: 'r' });
   await session.destroy();
});

test('teardown still raises when the substrate itself is broken', async () => {
   const { fetch } = stub((call) =>
      call.method === 'DELETE' ? json({ error: 'down' }, 503) : json({ sessionId: 'r' })
   );
   const driver = httpDriver({ ...OPTIONS, fetch });
   const session = await driver.createSession({ runId: 'r' });
   await assert.rejects(session.destroy(), ExecutionUnavailable);
});

test('plaintext is allowed only where it cannot leave a private network', () => {
   // The bearer token is on every request, so the rule is about where the
   // request can travel — not about which environment we think we are in.
   const allowed = [
      'http://runtime:4300', // the Compose service name: no public DNS meaning
      'http://localhost:4300',
      'http://127.0.0.1:8787',
      'http://10.1.2.3:4300',
      'http://172.20.0.5:4300',
      'http://192.168.1.9:4300',
   ];
   for (const baseUrl of allowed) {
      assert.doesNotThrow(() => httpDriver({ baseUrl, token: 't' }), baseUrl);
   }

   const refused = [
      'http://runtime.example.com', // a dotted name can cross the internet
      'http://8.8.8.8:4300',
      'http://172.32.0.1:4300', // just outside the private range
   ];
   for (const baseUrl of refused) {
      assert.throws(() => httpDriver({ baseUrl, token: 't' }), ExecutionUnavailable, baseUrl);
   }

   // https is always fine, wherever it points.
   assert.doesNotThrow(() => httpDriver({ baseUrl: 'https://runtime.example.com', token: 't' }));
});
