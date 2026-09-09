import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type Runtime } from './app.ts';
import type { Frame } from './demux.ts';

/**
 * The routes against a fake container runtime.
 *
 * These assert the half of the wire contract this service owns, and they assert it
 * without a daemon — so the authorization check and the exit-code handling are
 * exercised on every run of the suite rather than only when someone has Docker
 * up.
 */

const TOKEN = 'runtime-secret';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

type Emitted = Frame | { exitCode: number };

function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
   return {
      ping: async () => undefined,
      open: async (runId) => `berry-run-${runId}`,
      find: async (runId) => `berry-run-${runId}`,
      exec: async function* () {
         yield { exitCode: 0 };
      },
      putFile: async () => undefined,
      getFile: async () => '',
      kill: async () => undefined,
      remove: async () => undefined,
      atCapacity: async () => false,
      ...overrides,
   };
}

function app(runtime: Runtime = fakeRuntime(), token = TOKEN) {
   return createApp(runtime, { token, workdir: '/workspace' });
}

function emitting(items: Emitted[]): Runtime {
   return fakeRuntime({
      exec: async function* () {
         for (const item of items) yield item;
      },
   });
}

async function frames(response: Response): Promise<unknown[]> {
   return (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
}

test('health reports the daemon, not just the service', async () => {
   const ok = await app().request('/health');
   assert.equal(ok.status, 200);

   const degraded = await app(
      fakeRuntime({
         ping: async () => {
            throw new Error('socket missing');
         },
      })
   ).request('/health');
   assert.equal(degraded.status, 503);
   assert.deepEqual(await degraded.json(), {
      status: 'degraded',
      reason: 'container runtime unreachable',
   });
});

test('every session route refuses a request with no token', async () => {
   const routes: Array<[string, string]> = [
      ['POST', '/sessions'],
      ['POST', '/sessions/r/exec'],
      ['POST', '/sessions/r/exec/stream'],
      ['PUT', '/sessions/r/files'],
      ['GET', '/sessions/r/files?path=a'],
      ['POST', '/sessions/r/stop'],
      ['DELETE', '/sessions/r'],
   ];
   for (const [method, path] of routes) {
      const response = await app().request(path, { method });
      assert.equal(response.status, 401, `${method} ${path} was not refused`);
   }
});

test('the bare collection is guarded, not just the wildcard beneath it', async () => {
   const response = await app().request('/sessions', {
      method: 'POST',
      body: JSON.stringify({ runId: 'r' }),
   });
   assert.equal(response.status, 401);
});

test('a service with no token configured refuses everything', async () => {
   // Reachable from anything on the Compose network. An unconfigured secret
   // must fail closed rather than become an open remote shell.
   const response = await app(fakeRuntime(), '').request('/sessions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ runId: 'r' }),
   });
   assert.equal(response.status, 503);
});

test('a busy host delays a run rather than failing it', async () => {
   // 429 is what Berry maps to a retryable failure.
   const response = await app(fakeRuntime({ atCapacity: async () => true })).request('/sessions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ runId: 'r' }),
   });
   assert.equal(response.status, 429);
});

test('opening a session is idempotent for the same run', async () => {
   const opened: string[] = [];
   const runtime = fakeRuntime({
      open: async (runId) => {
         opened.push(runId);
         return `berry-run-${runId}`;
      },
   });
   for (let index = 0; index < 2; index += 1) {
      const response = await app(runtime).request('/sessions', {
         method: 'POST',
         headers: auth,
         body: JSON.stringify({ runId: 'r1' }),
      });
      assert.deepEqual(await response.json(), { sessionId: 'r1' });
   }
   assert.deepEqual(opened, ['r1', 'r1']);
});

test('a buffered command splits its streams and keeps the exit code', async () => {
   const response = await app(
      emitting([
         { kind: 'stdout', data: 'building\n' },
         { kind: 'stderr', data: 'warn\n' },
         { exitCode: 1 },
      ])
   ).request('/sessions/r/exec', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ command: 'pnpm build' }),
   });
   assert.deepEqual(await response.json(), {
      stdout: 'building\n',
      stderr: 'warn\n',
      exitCode: 1,
   });
});

test('a stream is emitted as Berry frames, start first and exit last', async () => {
   const response = await app(
      emitting([
         { kind: 'stdout', data: '84 passed\n' },
         { kind: 'stderr', data: '1 flaky\n' },
         { exitCode: 0 },
      ])
   ).request('/sessions/r/exec/stream', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ command: 'pnpm test' }),
   });

   assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
   assert.deepEqual(await frames(response), [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: '84 passed\n' },
      { type: 'stderr', seq: 2, data: '1 flaky\n' },
      { type: 'exit', seq: 3, exitCode: 0 },
   ]);
});

test('a stream that never reports an exit says so rather than ending quietly', async () => {
   // Read as a success, this would record a run as finished with a code
   // nobody sent — which is how a failing change gets approved.
   const response = await app(emitting([{ kind: 'stdout', data: 'installing…' }])).request(
      '/sessions/r/exec/stream',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'pnpm install' }) }
   );
   const emitted = await frames(response);
   assert.deepEqual(emitted.at(-1), {
      type: 'error',
      seq: 2,
      message: 'command stream ended without reporting an exit',
   });
});

test('a daemon that throws mid-stream becomes an error frame, not a dropped connection', async () => {
   const runtime = fakeRuntime({
      exec: async function* () {
         yield { kind: 'stdout', data: 'starting\n' } as Frame;
         throw new Error('container evicted');
      },
   });
   const response = await app(runtime).request('/sessions/r/exec/stream', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ command: 'pnpm test' }),
   });
   assert.deepEqual(await frames(response), [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: 'starting\n' },
      { type: 'error', seq: 2, message: 'container evicted' },
   ]);
});

test('a command against an unknown session is a 404, not a new workspace', async () => {
   const response = await app(fakeRuntime({ find: async () => null })).request(
      '/sessions/ghost/exec',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'ls' }) }
   );
   assert.equal(response.status, 404);
});

test('destroying a session that is already gone still succeeds', async () => {
   // Berry calls this on the failure path. A 404 would replace the real reason
   // a run failed with a complaint about tidying up.
   const response = await app(fakeRuntime({ find: async () => null })).request('/sessions/ghost', {
      method: 'DELETE',
      headers: auth,
   });
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { destroyed: true });
});

test('files round-trip through the session', async () => {
   const written: Array<[string, string]> = [];
   const runtime = fakeRuntime({
      putFile: async (_id, path, content) => void written.push([path, content]),
      getFile: async () => 'export const answer = 42;\n',
   });

   const put = await app(runtime).request('/sessions/r/files', {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ path: 'src/answer.ts', content: 'export const answer = 42;\n' }),
   });
   assert.equal(put.status, 200);
   assert.deepEqual(written, [['src/answer.ts', 'export const answer = 42;\n']]);

   const get = await app(runtime).request('/sessions/r/files?path=src/answer.ts', {
      headers: auth,
   });
   assert.deepEqual(await get.json(), { content: 'export const answer = 42;\n' });
});

test('stop kills and destroy removes', async () => {
   const seen: string[] = [];
   const runtime = fakeRuntime({
      kill: async () => void seen.push('kill'),
      remove: async () => void seen.push('remove'),
   });
   await app(runtime).request('/sessions/r/stop', { method: 'POST', headers: auth });
   await app(runtime).request('/sessions/r', { method: 'DELETE', headers: auth });
   assert.deepEqual(seen, ['kill', 'remove']);
});

test('a request missing its required field is refused before the daemon is touched', async () => {
   let touched = false;
   const runtime = fakeRuntime({
      exec: async function* () {
         touched = true;
         yield { exitCode: 0 };
      },
   });
   const response = await app(runtime).request('/sessions/r/exec', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({}),
   });
   assert.equal(response.status, 400);
   assert.equal(touched, false);
});

test('a relative working directory is resolved against the workspace root', async () => {
   // Docker rejects a relative Cwd outright, so a caller that says
   // `repo/packages/api` would fail on one substrate and work on the other —
   // which is exactly the difference the protocol exists to remove.
   const seen: Array<string | undefined> = [];
   const runtime = fakeRuntime({
      exec: async function* (_id, _command, options) {
         seen.push(options.cwd);
         yield { exitCode: 0 };
      },
   });
   for (const cwd of ['repo', './repo/packages/api', '/absolute/elsewhere', undefined]) {
      await app(runtime).request('/sessions/r/exec', {
         method: 'POST',
         headers: auth,
         body: JSON.stringify({ command: 'ls', ...(cwd === undefined ? {} : { cwd }) }),
      });
   }
   assert.deepEqual(seen, [
      '/workspace/repo',
      '/workspace/repo/packages/api',
      '/absolute/elsewhere',
      undefined,
   ]);
});

test('a command is bounded even when the caller does not ask', async () => {
   // An unbounded command holds a container open until something else reaps
   // it. The protocol says a substrate bounds what it runs, so the default
   // lives here rather than in every caller.
   const seen: Array<number | undefined> = [];
   const runtime = fakeRuntime({
      exec: async function* (_id, _command, options) {
         seen.push(options.timeoutMs);
         yield { exitCode: 0 };
      },
   });
   for (const body of [{ command: 'sleep 1' }, { command: 'sleep 1', timeoutMs: 2_000 }]) {
      await app(runtime).request('/sessions/r/exec', {
         method: 'POST',
         headers: auth,
         body: JSON.stringify(body),
      });
   }
   assert.ok((seen[0] ?? 0) > 0, 'an unbounded command was allowed through');
   assert.equal(seen[1], 2_000, 'the caller\'s ceiling was ignored');
});
