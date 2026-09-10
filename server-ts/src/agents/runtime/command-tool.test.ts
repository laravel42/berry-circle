import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommandTool } from './command-tool.ts';
import { ExecutionUnavailable, type ExecEvent, type ExecutionSession } from '../../execution/driver.ts';
import type { RunLedger } from '../../runs/ledger.ts';
import { StateStore, type ToolContext } from '@strands-agents/sdk';
import { WORKDIR_KEY } from './command-tool.ts';

/**
 * The tool that turns a run into something you can watch.
 *
 * The ledger and the session are both fakes, so these run offline. What they
 * pin is the behaviour a live run depends on: a failing command reaching the
 * model as a result, the command itself reaching the log, and neither the
 * ledger nor the prompt being drowned by a noisy build.
 */

interface Recorded {
   type: 'started' | 'output' | 'completed';
   [key: string]: unknown;
}

function fakeLedger(): { ledger: RunLedger; events: Recorded[] } {
   const events: Recorded[] = [];
   const ledger = {
      appendCommandStarted: async (_runId: string, params: object) => {
         events.push({ type: 'started', ...params });
      },
      appendCommandOutput: async (_runId: string, params: object) => {
         events.push({ type: 'output', ...params });
      },
      appendCommandCompleted: async (_runId: string, params: object) => {
         events.push({ type: 'completed', ...params });
      },
   } as unknown as RunLedger;
   return { ledger, events };
}

function fakeSession(events: ExecEvent[], onStream?: (command: string, options: unknown) => void) {
   return {
      id: 'run-1',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      stream: (command: string, options?: unknown) => {
         onStream?.(command, options);
         return {
            async *[Symbol.asyncIterator]() {
               for (const event of events) yield event;
            },
         };
      },
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   } satisfies ExecutionSession;
}

/** A clock that advances past the flush interval on every read. */
function tickingClock(): () => Date {
   let now = 0;
   return () => new Date((now += 1000));
}

function tool(session: ExecutionSession, ledger: RunLedger, clock = tickingClock()) {
   let counter = 0;
   return runCommandTool({
      ledger,
      runId: 'run-1',
      session: async () => session,
      newId: () => `cmd-${++counter}`,
      clock,
   });
}

/**
 * Invokes a tool the way the agent loop does.
 *
 * `invoke` rather than reaching for the callback: it is the entry point the
 * SDK actually uses, so a schema that stopped matching the arguments would
 * fail here too rather than only in production.
 */
async function call(
   t: ReturnType<typeof tool>,
   args: object,
   context?: Partial<Pick<ToolContext, 'cancelSignal'>> & { workdir?: string }
): Promise<Record<string, unknown>> {
   const invoke = (t as unknown as { invoke: (a: object, c?: unknown) => Promise<unknown> }).invoke;
   const toolContext = context
      ? {
           ...(context.cancelSignal ? { cancelSignal: context.cancelSignal } : {}),
           agent: { appState: new StateStore(context.workdir ? { [WORKDIR_KEY]: context.workdir } : {}) },
        }
      : undefined;
   return (await invoke.call(t, args, toolContext)) as Record<string, unknown>;
}

test('a failing command is a result the model can read, not an exception', async () => {
   // The whole reason the tool exists is to let an agent discover that the
   // tests failed. Throwing would hide it.
   const { ledger } = fakeLedger();
   const session = fakeSession([
      { type: 'start', seq: 0, command: 'pnpm test' },
      { type: 'stderr', seq: 1, data: 'error: type mismatch\n' },
      { type: 'exit', seq: 2, exitCode: 1 },
   ]);
   const result = await call(tool(session, ledger), { command: 'pnpm test' });
   assert.equal(result.exitCode, 1);
   assert.equal(result.stderr, 'error: type mismatch\n');
});

test('the command is recorded verbatim, which the other tools never do', async () => {
   const { ledger, events } = fakeLedger();
   const session = fakeSession([{ type: 'exit', seq: 0, exitCode: 0 }]);
   await call(tool(session, ledger), { command: '  pnpm install --frozen-lockfile  ' });

   const started = events.find((event) => event.type === 'started');
   assert.equal(started?.command, 'pnpm install --frozen-lockfile');
   assert.equal(started?.commandId, 'cmd-1');
});

test('the three events share a command id, so interleaved commands stay apart', async () => {
   const { ledger, events } = fakeLedger();
   const session = fakeSession([
      { type: 'stdout', seq: 0, data: 'x' },
      { type: 'exit', seq: 1, exitCode: 0 },
   ]);
   await call(tool(session, ledger), { command: 'echo x' });
   assert.deepEqual(
      events.map((event) => [event.type, event.commandId]),
      [
         ['started', 'cmd-1'],
         ['output', 'cmd-1'],
         ['completed', 'cmd-1'],
      ]
   );
});

test('output reaches the ledger on the stream it was written to', async () => {
   const { ledger, events } = fakeLedger();
   const session = fakeSession([
      { type: 'stdout', seq: 0, data: '84 passed\n' },
      { type: 'stderr', seq: 1, data: '1 flaky\n' },
      { type: 'exit', seq: 2, exitCode: 0 },
   ]);
   await call(tool(session, ledger), { command: 'pnpm test' });

   const output = events.filter((event) => event.type === 'output');
   assert.deepEqual(
      output.map((event) => [event.stream, event.text]),
      [
         ['stdout', '84 passed\n'],
         ['stderr', '1 flaky\n'],
      ]
   );
});

test('a noisy command does not become one ledger row per write', async () => {
   // A build emits thousands of small writes. One row each would make
   // run_events a character log.
   const { ledger, events } = fakeLedger();
   const chatty: ExecEvent[] = Array.from({ length: 200 }, (_unused, index) => ({
      type: 'stdout' as const,
      seq: index,
      data: 'x'.repeat(10),
   }));
   chatty.push({ type: 'exit', seq: 200, exitCode: 0 });

   // A clock that never advances, so only the size threshold can flush.
   const frozen = () => new Date(0);
   await call(tool(fakeSession(chatty), ledger, frozen), { command: 'pnpm build' });

   const rows = events.filter((event) => event.type === 'output').length;
   assert.ok(rows < 10, `expected coalescing, got ${rows} rows for 200 writes`);
   // Nothing was dropped on the way.
   const recorded = events
      .filter((event) => event.type === 'output')
      .map((event) => event.text as string)
      .join('');
   assert.equal(recorded.length, 2000);
});

test('a run away command is truncated in the ledger, and says so', async () => {
   const { ledger, events } = fakeLedger();
   const flood: ExecEvent[] = Array.from({ length: 40 }, (_unused, index) => ({
      type: 'stdout' as const,
      seq: index,
      data: 'y'.repeat(16 * 1024),
   }));
   flood.push({ type: 'exit', seq: 40, exitCode: 0 });

   const result = await call(tool(fakeSession(flood), ledger), { command: 'yes' });

   const recorded = events
      .filter((event) => event.type === 'output')
      .reduce((total, event) => total + (event.text as string).length, 0);
   assert.equal(recorded, 256 * 1024);
   assert.equal(events.find((event) => event.type === 'completed')?.truncated, true);
   assert.equal(result.note, 'output was truncated in the run log');
});

test('the model is handed the tail, because that is where a failure explains itself', async () => {
   const { ledger } = fakeLedger();
   const session = fakeSession([
      { type: 'stdout', seq: 0, data: 'a'.repeat(10_000) },
      { type: 'stdout', seq: 1, data: 'FAILED: the last line\n' },
      { type: 'exit', seq: 2, exitCode: 1 },
   ]);
   const result = await call(tool(session, ledger), { command: 'pnpm test' });

   const stdout = result.stdout as string;
   assert.ok(stdout.length < 5_000, 'the model was handed the whole log');
   assert.match(stdout, /FAILED: the last line/);
   // Said plainly, so the model does not read a clipped log as the whole story.
   assert.match(stdout, /earlier output omitted/);
});

test('a stream that never reports an exit is an error, not a success', async () => {
   const { ledger, events } = fakeLedger();
   const session = fakeSession([{ type: 'error', seq: 0, message: 'container evicted' }]);
   const result = await call(tool(session, ledger), { command: 'pnpm test' });

   assert.equal(result.exitCode, null);
   assert.equal(result.error, 'container evicted');
   // Still recorded: the run must show the command was attempted.
   assert.equal(events.find((event) => event.type === 'completed')?.exitCode, null);
});

test('a substrate that cannot give a workspace is reported, not thrown', async () => {
   // The agent should say so rather than retry a command that cannot run.
   const { ledger, events } = fakeLedger();
   const failing = runCommandTool({
      ledger,
      runId: 'run-1',
      session: async () => {
         throw new ExecutionUnavailable('no execution substrate is configured');
      },
      newId: () => 'cmd-1',
   });
   const result = await call(failing as ReturnType<typeof tool>, { command: 'pnpm test' });

   assert.equal(result.exitCode, null);
   assert.match(result.error as string, /no workspace is available/);
   // Nothing was recorded, because nothing ran.
   assert.deepEqual(events, []);
});

test('an empty command is refused before a workspace is opened', async () => {
   let opened = false;
   const { ledger } = fakeLedger();
   const refusing = runCommandTool({
      ledger,
      runId: 'run-1',
      session: async () => {
         opened = true;
         return fakeSession([]);
      },
      newId: () => 'cmd-1',
   });
   const result = await call(refusing as ReturnType<typeof tool>, { command: '   ' });
   assert.equal(result.exitCode, null);
   assert.equal(opened, false);
});

test('a working directory is passed through, and omitted when unset', async () => {
   const { ledger } = fakeLedger();
   const seen: unknown[] = [];
   const session = fakeSession([{ type: 'exit', seq: 0, exitCode: 0 }], (_command, options) =>
      seen.push(options)
   );

   await call(tool(session, ledger), { command: 'ls', cwd: '/workspace/repo' });
   await call(tool(session, ledger), { command: 'ls' });

   assert.deepEqual(seen, [{ cwd: '/workspace/repo' }, {}]);
});

test('the run\'s cancellation reaches the command, not just the model call', async () => {
   // The gap this closes: the model loop only checks between events, and a
   // tool parked on `pnpm test` produces none for minutes. Without the signal
   // reaching the substrate the run reads as cancelled while the command runs
   // to completion in a container nobody will reap.
   const { ledger } = fakeLedger();
   const seen: unknown[] = [];
   const controller = new AbortController();
   const session = fakeSession([{ type: 'exit', seq: 0, exitCode: 0 }], (_command, options) =>
      seen.push(options)
   );

   await call(tool(session, ledger), { command: 'pnpm test' }, { cancelSignal: controller.signal });

   assert.deepEqual(seen, [{ signal: controller.signal }]);
});

test('a cancelled command says so, rather than reporting a broken substrate', async () => {
   // The person asked for this. Reporting it as an infrastructure fault would
   // have the agent retry a command it was told to stop.
   const { ledger, events } = fakeLedger();
   const controller = new AbortController();
   const session = {
      id: 'run-1',
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      stream: () => ({
         async *[Symbol.asyncIterator]() {
            yield { type: 'stdout', seq: 0, data: 'building\n' } as ExecEvent;
            controller.abort();
            throw new Error('The operation was aborted');
         },
      }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   } satisfies ExecutionSession;

   const result = await call(
      tool(session, ledger),
      { command: 'pnpm build' },
      { cancelSignal: controller.signal }
   );

   assert.equal(result.exitCode, null);
   assert.equal(result.error, 'the run was cancelled');
   // What it had produced is still part of the record.
   assert.equal(events.find((event) => event.type === 'output')?.text, 'building\n');
   assert.equal(events.find((event) => event.type === 'completed')?.exitCode, null);
});

test('a run that ends mid-command still gets a result, not an exception', async () => {
   // The ledger refuses an append to a terminal run, and a cancellation makes
   // the run terminal while the command is still draining. The tool owes the
   // model a result either way — throwing would surface the run's own ending
   // as a tool fault.
   const refusing = {
      appendCommandStarted: async () => undefined,
      appendCommandOutput: async () => {
         throw new Error('run is terminal');
      },
      appendCommandCompleted: async () => {
         throw new Error('run is terminal');
      },
   } as unknown as RunLedger;

   const session = fakeSession([
      { type: 'stdout', seq: 0, data: 'partial\n' },
      { type: 'exit', seq: 1, exitCode: 0 },
   ]);
   // A clock that never advances, so the only ledger write is the final flush
   // and the completion beside it — the two the tool makes after the command
   // is already over.
   const result = await call(tool(session, refusing, () => new Date(0)), {
      command: 'pnpm build',
   });
   assert.equal(result.exitCode, 0);
});

test('a command runs in the checkout when the run has one, unless told otherwise', async () => {
   // The tools are built before the repository is cloned, so the directory is
   // read from the agent's state at call time rather than fixed at
   // construction — which would always be the workspace root.
   const { ledger, events } = fakeLedger();
   const seen: unknown[] = [];
   const session = fakeSession([{ type: 'exit', seq: 0, exitCode: 0 }], (_command, options) =>
      seen.push(options)
   );

   await call(tool(session, ledger), { command: 'pnpm test' }, { workdir: 'circle' });
   await call(tool(session, ledger), { command: 'ls', cwd: 'elsewhere' }, { workdir: 'circle' });

   assert.deepEqual(seen, [{ cwd: 'circle' }, { cwd: 'elsewhere' }]);
   assert.equal(events.find((event) => event.type === 'started')?.cwd, 'circle');
});
