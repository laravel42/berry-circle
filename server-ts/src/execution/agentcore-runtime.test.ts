import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCoreRuntimeDriver, runtimeSessionId } from './agentcore-runtime.ts';
import { ExecutionUnavailable } from './driver.ts';

/**
 * AgentCore Runtimes as a substrate, against a fake client.
 *
 * The point of these tests, like the Code Interpreter driver's, is that this
 * satisfies the same `ExecutionSession` contract — a command produces a start,
 * output and an exit — so the run ledger stays unaware of where work happened.
 * The wire shape differs: output arrives as `contentDelta` chunks and the exit
 * as a `contentStop`.
 */

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/berry-abc';

interface StreamChunk {
   contentStart?: Record<string, never>;
   contentDelta?: { stdout?: string; stderr?: string };
   contentStop?: { exitCode: number; status: 'COMPLETED' | 'TIMED_OUT' };
}

function fake(
   options: {
      chunks?: StreamChunk[];
      /** Emitted as a typed stream error variant instead of a chunk. */
      streamError?: string;
      /** Omit the terminal contentStop to simulate a truncated stream. */
      noStop?: boolean;
      invokeFails?: boolean;
   } = {}
) {
   const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
   const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
         sent.push({ name: command.constructor.name, input: command.input });
         if (command.constructor.name === 'InvokeAgentRuntimeCommandCommand') {
            if (options.invokeFails) throw new Error('network down');
            if (options.streamError) {
               return { stream: [{ runtimeClientError: { message: options.streamError } }] };
            }
            const chunks =
               options.chunks ??
               ([
                  { contentDelta: { stdout: 'hello\n' } },
                  { contentStop: { exitCode: 0, status: 'COMPLETED' } },
               ] as StreamChunk[]);
            const stream = chunks.map((chunk) => ({ chunk }));
            if (options.noStop) {
               return { stream: [{ chunk: { contentDelta: { stdout: 'partial' } } }] };
            }
            return { stream };
         }
         if (command.constructor.name === 'StopRuntimeSessionCommand') {
            return { statusCode: 200 };
         }
         return {};
      },
   };
   return { sent, client: client as never };
}

function driver(f: ReturnType<typeof fake>) {
   return agentCoreRuntimeDriver({ region: 'us-east-1', runtimeArn: ARN, client: f.client });
}

test('a session is addressed by the run, so a retry reaches the same session', async () => {
   const f = fake();
   const first = await driver(f).createSession({ runId: 'run-42' });
   const again = await driver(f).createSession({ runId: 'run-42' });
   // Same run derives the same session id, so a retry lands on the same session.
   assert.equal(first.id, again.id);
   assert.equal(first.id, runtimeSessionId('run:run-42'), 'the session id is derived from the run');
   // Long enough for AgentCore's 33-char minimum even for a short run id.
   assert.ok(first.id.length >= 33, `session id must be >= 33 chars, got ${first.id.length}`);
});

test('the invoke carries the documented envelope: contentType, accept and qualifier', async () => {
   // `accept` is load-bearing — the response is an event stream, and the
   // reference call asks for it by name rather than relying on an SDK default.
   const f = fake();
   const session = await driver(f).createSession({ runId: 'r' });
   // Drained, not broken out of: the driver yields `start` before it sends the
   // command, so an early break records no invoke at all.
   await session.exec('echo hi');

   const invoke = f.sent.find((s) => s.name === 'InvokeAgentRuntimeCommandCommand')!;
   assert.equal(invoke.input.contentType, 'application/json');
   assert.equal(invoke.input.accept, 'application/vnd.amazon.eventstream');
   assert.equal(invoke.input.qualifier, 'DEFAULT');
});

test('an explicit qualifier overrides the DEFAULT alias', async () => {
   const f = fake();
   const pinned = agentCoreRuntimeDriver({
      region: 'us-east-1',
      runtimeArn: ARN,
      qualifier: 'prod',
      client: f.client,
   });
   const session = await pinned.createSession({ runId: 'r' });
   await session.exec('echo hi');

   const invoke = f.sent.find((s) => s.name === 'InvokeAgentRuntimeCommandCommand')!;
   assert.equal(invoke.input.qualifier, 'prod');
});

test('the command is wrapped for a shell, because AgentCore execs argv instead', async () => {
   // Verified against the live service: a raw string is tokenized and exec'd,
   // so `echo a && echo b` printed a literal `&&` and `for` was looked up as a
   // binary. The wrapper is what makes an agent's shell actually be a shell.
   const f = fake();
   const session = await driver(f).createSession({ runId: 'r' });
   await session.exec('echo ONE && echo TWO');

   const invoke = f.sent.find((s) => s.name === 'InvokeAgentRuntimeCommandCommand')!;
   const body = invoke.input.body as { command: string };
   assert.match(body.command, /^\/bin\/bash -c "echo [A-Za-z0-9+/=]+ \| base64 -d \| \/bin\/bash"$/);

   // The payload decodes to exactly the caller's script, and carries no
   // quoting for the tokenizer to mangle.
   const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(body.command)![1]!;
   assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'echo ONE && echo TWO');
});

test('writeFile does not append a blank line to content already ending in a newline', async () => {
   const f = fake();
   const session = await driver(f).createSession({ runId: 'r' });
   await session.writeFile('/tmp/f.txt', 'one line\n');

   const invoke = f.sent.find((s) => s.name === 'InvokeAgentRuntimeCommandCommand')!;
   const body = invoke.input.body as { command: string };
   const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(body.command)![1]!;
   const script = Buffer.from(encoded, 'base64').toString('utf8');
   // The heredoc body is the content followed straight by the terminator, with
   // no blank line between them.
   assert.match(script, /one line\nBERRY_EOF_[A-Z0-9]+$/);
});

test('a command produces start, output and exit', async () => {
   const f = fake({
      chunks: [
         { contentDelta: { stdout: 'hello\n' } },
         { contentStop: { exitCode: 0, status: 'COMPLETED' } },
      ],
   });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('echo hello')) events.push(event);

   assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'stdout', 'exit']
   );
   const first = events[0]!;
   const last = events.at(-1)!;
   assert.equal(first.type === 'start' && first.command, 'echo hello');
   assert.equal(last.type === 'exit' && last.exitCode, 0);
});

test('stderr and a non-zero exit are surfaced', async () => {
   const f = fake({
      chunks: [
         { contentDelta: { stderr: 'no such file' } },
         { contentStop: { exitCode: 1, status: 'COMPLETED' } },
      ],
   });
   const session = await driver(f).createSession({ runId: 'r' });
   const result = await session.exec('cat missing');

   assert.equal(result.exitCode, 1);
   assert.match(result.stderr, /no such file/);
});

test('a timeout is an error event and still closes the stream with an exit', async () => {
   const f = fake({ chunks: [{ contentStop: { exitCode: 124, status: 'TIMED_OUT' } }] });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('sleep 999')) events.push(event);
   assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'error', 'exit']
   );
});

test('a typed stream error is an event, not a throw', async () => {
   const f = fake({ streamError: 'throttled' });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('anything')) events.push(event);
   const kinds = events.map((e) => e.type);
   assert.ok(kinds.includes('error'));
   assert.ok(kinds.includes('exit'));
});

test('a stream with no exit is closed as an error, not a silent success', async () => {
   const f = fake({ noStop: true });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('half a command')) events.push(event);
   const last = events.at(-1)!;
   assert.equal(last.type === 'exit' && last.exitCode, 1);
   assert.ok(events.some((e) => e.type === 'error'));
});

test('a command that could not be sent is an event, not a throw', async () => {
   const f = fake({ invokeFails: true });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('anything')) events.push(event);
   assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'error', 'exit']
   );
});

test('the recorded command is the caller’s, not the one with the environment in it', async () => {
   const f = fake();
   const session = await driver(f).createSession({
      runId: 'r',
      env: { GIT_TOKEN: 'super-secret' },
   });

   const events = [];
   for await (const event of session.stream('git push')) events.push(event);

   const start = events[0]!;
   assert.equal(start.type === 'start' && start.command, 'git push');
   assert.ok(
      !JSON.stringify(start).includes('super-secret'),
      'the recorded command must not carry the credential'
   );
   // The credential still reaches the sandbox — it is exported inside the
   // base64-wrapped script, which is what the SDK carries. Decoded here so the
   // assertion survives the wrapper rather than depending on its shape.
   const invoke = f.sent.find((s) => s.name === 'InvokeAgentRuntimeCommandCommand')!;
   const body = invoke.input.body as { command: string };
   const encoded = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(body.command)?.[1] ?? '';
   assert.match(Buffer.from(encoded, 'base64').toString('utf8'), /super-secret/);
});

test('destroy stops the runtime session and is idempotent', async () => {
   const f = fake();
   const session = await driver(f).createSession({ runId: 'r' });
   await session.destroy();
   await session.destroy();
   const stops = f.sent.filter((s) => s.name === 'StopRuntimeSessionCommand');
   assert.equal(stops.length, 1, 'the session is stopped exactly once');
   assert.equal(stops[0]?.input.agentRuntimeArn, ARN);
});

test('a command after destroy is refused', async () => {
   const session = await driver(fake()).createSession({ runId: 'r' });
   await session.destroy();
   await assert.rejects(async () => {
      for await (const _ of session.stream('echo hi')) break;
   }, ExecutionUnavailable);
});
