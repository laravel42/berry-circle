import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, type Env, type SandboxLike } from './app.ts';

/**
 * The worker's routes against a fake sandbox.
 *
 * The authorization check is the reason this file exists. It is the only thing
 * between the open internet and a container that runs arbitrary commands, and
 * a check that can only be exercised by deploying is one nobody exercises.
 */

const TOKEN = 'runtime-secret';
const ENV: Env = { Sandbox: null, BERRY_RUNTIME_TOKEN: TOKEN };

function fakeSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
   return {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      execStream: async () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      writeFile: async () => undefined,
      readFile: async () => ({ content: '' }),
      killAllProcesses: async () => undefined,
      destroy: async () => undefined,
      ...overrides,
   };
}

function app(sandbox: SandboxLike = fakeSandbox(), events: unknown[] = []) {
   return createApp({
      sandbox: () => sandbox,
      parseStream: <T,>(_stream: ReadableStream<Uint8Array>) => ({
         async *[Symbol.asyncIterator]() {
            for (const event of events) yield event as T;
         },
      }),
   });
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

test('health needs no credential — it says nothing about the caller', async () => {
   const response = await app().request('/health', {}, ENV);
   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { status: 'ok' });
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
      const response = await app().request(path, { method }, ENV);
      assert.equal(response.status, 401, `${method} ${path} was not refused`);
   }
});

test('the bare collection is guarded, not just the wildcard beneath it', async () => {
   // `/sessions/*` does not match `/sessions`. Creating a sandbox is the most
   // expensive thing this worker does, so an unguarded create would be the
   // worst one to leave open.
   const response = await app().request(
      '/sessions',
      { method: 'POST', body: JSON.stringify({ runId: 'r' }) },
      ENV
   );
   assert.equal(response.status, 401);
});

test('a wrong token is refused, and so is a malformed header', async () => {
   for (const header of ['Bearer wrong', 'Basic ' + TOKEN, TOKEN, 'Bearer', '']) {
      const response = await app().request(
         '/sessions',
         { method: 'POST', headers: { authorization: header }, body: JSON.stringify({ runId: 'r' }) },
         ENV
      );
      assert.equal(response.status, 401, `accepted: ${JSON.stringify(header)}`);
   }
});

test('a worker with no token configured refuses everything', async () => {
   // An unconfigured secret must fail closed. The alternative is an open
   // remote shell on the public internet.
   const response = await app().request(
      '/sessions',
      { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r' }) },
      { Sandbox: null, BERRY_RUNTIME_TOKEN: '' }
   );
   assert.equal(response.status, 503);
});

test('creating a session touches the sandbox before reporting success', async () => {
   let touched = false;
   const response = await app(
      fakeSandbox({
         exec: async () => {
            touched = true;
            return { stdout: '', stderr: '', exitCode: 0 };
         },
      })
   ).request('/sessions', { method: 'POST', headers: auth, body: JSON.stringify({ runId: 'r1' }) }, ENV);

   assert.equal(response.status, 200);
   assert.deepEqual(await response.json(), { sessionId: 'r1' });
   assert.equal(touched, true);
});

test('a command passes its options through and returns the exit code', async () => {
   let seen: unknown;
   const response = await app(
      fakeSandbox({
         exec: async (command, options) => {
            seen = { command, options };
            return { stdout: 'ok', stderr: '', exitCode: 3 };
         },
      })
   ).request(
      '/sessions/r/exec',
      {
         method: 'POST',
         headers: auth,
         body: JSON.stringify({ command: 'pnpm test', cwd: '/workspace', timeoutMs: 1000 }),
      },
      ENV
   );

   assert.deepEqual(await response.json(), { stdout: 'ok', stderr: '', exitCode: 3 });
   assert.deepEqual(seen, {
      command: 'pnpm test',
      options: { cwd: '/workspace', timeout: 1000 },
   });
});

test('a command with no timeout gets a bounded one, never unlimited', async () => {
   let options: { timeout?: number } | undefined;
   await app(
      fakeSandbox({
         exec: async (_command, received) => {
            options = received;
            return { stdout: '', stderr: '', exitCode: 0 };
         },
      })
   ).request(
      '/sessions/r/exec',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'sleep 1' }) },
      ENV
   );
   assert.ok((options?.timeout ?? 0) > 0);
});

test('a stream is translated into Berry frames, in order', async () => {
   const response = await app(fakeSandbox(), [
      { type: 'start', command: 'pnpm test' },
      { type: 'stdout', data: '84 passed' },
      { type: 'complete', exitCode: 0 },
   ]).request(
      '/sessions/r/exec/stream',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'pnpm test' }) },
      ENV
   );

   assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
   const frames = (await response.text())
      .split('\n\n')
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, '')));
   assert.deepEqual(frames, [
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stdout', seq: 1, data: '84 passed' },
      { type: 'exit', seq: 2, exitCode: 0 },
   ]);
});

test('a stream that never reports an exit says so rather than ending quietly', async () => {
   const response = await app(fakeSandbox(), [{ type: 'stdout', data: 'installing…' }]).request(
      '/sessions/r/exec/stream',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'pnpm install' }) },
      ENV
   );
   const text = await response.text();
   assert.match(text, /"type":"error"/);
   assert.match(text, /without reporting an exit/);
});

test('a sandbox that throws mid-stream becomes an error frame, not a dropped connection', async () => {
   const app = createApp({
      sandbox: () => fakeSandbox(),
      parseStream: <T,>() => ({
         // eslint-disable-next-line require-yield
         async *[Symbol.asyncIterator](): AsyncGenerator<T> {
            throw new Error('container evicted');
         },
      }),
   });
   const response = await app.request(
      '/sessions/r/exec/stream',
      { method: 'POST', headers: auth, body: JSON.stringify({ command: 'pnpm test' }) },
      ENV
   );
   assert.match(await response.text(), /container evicted/);
});

test('a request missing its required field is refused before the sandbox is touched', async () => {
   let touched = false;
   const sandbox = fakeSandbox({
      exec: async () => {
         touched = true;
         return { stdout: '', stderr: '', exitCode: 0 };
      },
   });
   const response = await app(sandbox).request(
      '/sessions/r/exec',
      { method: 'POST', headers: auth, body: JSON.stringify({}) },
      ENV
   );
   assert.equal(response.status, 400);
   assert.equal(touched, false);
});

test('stop kills processes and destroy tears the workspace down', async () => {
   const seen: string[] = [];
   const sandbox = fakeSandbox({
      killAllProcesses: async () => void seen.push('kill'),
      destroy: async () => void seen.push('destroy'),
   });
   await app(sandbox).request('/sessions/r/stop', { method: 'POST', headers: auth }, ENV);
   await app(sandbox).request('/sessions/r', { method: 'DELETE', headers: auth }, ENV);
   assert.deepEqual(seen, ['kill', 'destroy']);
});
