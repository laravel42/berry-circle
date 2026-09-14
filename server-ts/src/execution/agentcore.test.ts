import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCoreDriver } from './agentcore.ts';
import { ExecutionUnavailable } from './driver.ts';

/**
 * AgentCore as a substrate, against a fake client.
 *
 * What matters here is that it satisfies the same contract as the Docker
 * driver — a command produces a start, output and an exit — because that
 * contract is what lets the run ledger stay unaware of where work happened.
 */

function fake(options: {
   chunks?: Array<{ isError?: boolean; text?: string }>;
   startFails?: boolean;
   invokeFails?: boolean;
} = {}) {
   const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
   const client = {
      async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
         sent.push({ name: command.constructor.name, input: command.input });
         if (command.constructor.name === 'StartCodeInterpreterSessionCommand') {
            if (options.startFails) throw new Error('AccessDeniedException');
            return { sessionId: 'sess-1' };
         }
         if (command.constructor.name === 'InvokeCodeInterpreterCommand') {
            if (options.invokeFails) throw new Error('network down');
            return {
               stream: (options.chunks ?? [{ text: 'hello\n' }]).map((chunk) => ({
                  result: {
                     isError: chunk.isError ?? false,
                     content: [{ text: chunk.text ?? '' }],
                  },
               })),
            };
         }
         return {};
      },
   };
   return { sent, client: client as never };
}

function driver(f: ReturnType<typeof fake>) {
   return agentCoreDriver({
      region: 'us-east-1',
      codeInterpreterId: 'aws.codeinterpreter.v1',
      client: f.client,
   });
}

test('a session is addressed by the run, so a retry reaches the same workspace', async () => {
   const f = fake();
   await driver(f).createSession({ runId: 'run-42' });
   assert.equal(f.sent[0]?.input.name, 'berry-run-42');
});

test('a command produces start, output and exit', async () => {
   const f = fake({ chunks: [{ text: 'hello\n' }] });
   const session = await driver(f).createSession({ runId: 'r' });

   const events = [];
   for await (const event of session.stream('echo hello')) events.push(event);

   assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'stdout', 'exit']
   );
   const first = events[0]!;
   const last = events[2]!;
   assert.equal(first.type === 'start' && first.command, 'echo hello');
   assert.equal(last.type === 'exit' && last.exitCode, 0);
});

test('an error result is stderr and a non-zero exit', async () => {
   const f = fake({ chunks: [{ isError: true, text: 'no such file' }] });
   const session = await driver(f).createSession({ runId: 'r' });
   const result = await session.exec('cat missing');

   assert.equal(result.exitCode, 1);
   assert.match(result.stderr, /no such file/);
});

test('a command that could not be sent is an event, not a throw', async () => {
   // A command that failed to send and one that ran and failed look the same
   // to a reader of the run, and both belong in the stream.
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
   // `run.command.started` is streamed to every browser watching the run, so a
   // secret exported as part of the command would be published to the workspace.
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
});

test('an unreachable substrate is refused rather than reported as a failed run', async () => {
   // A run that could not start is not a run that failed.
   const f = fake({ startFails: true });
   await assert.rejects(driver(f).createSession({ runId: 'r' }), ExecutionUnavailable);
});

test('destroying twice is not an error', async () => {
   const session = await driver(fake()).createSession({ runId: 'r' });
   await session.destroy();
   await session.destroy();
});

test('a command after destroy is refused', async () => {
   const session = await driver(fake()).createSession({ runId: 'r' });
   await session.destroy();
   await assert.rejects(async () => {
      for await (const _ of session.stream('echo hi')) break;
   }, ExecutionUnavailable);
});
