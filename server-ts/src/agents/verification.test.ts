import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarise, verify } from './verification.ts';
import type { ExecOptions, ExecResult, ExecutionSession } from '../execution/driver.ts';

/**
 * The evidence a pull request arrives with.
 *
 * What these pin is mostly about honesty: a check that could not run must not
 * read as one that passed, and a set cut short must not read as one that
 * finished.
 */

interface Call {
   command: string;
   cwd: string | undefined;
   timeoutMs: number | undefined;
}

function fakeSession(
   handler: (command: string) => Partial<ExecResult> | Error
): { session: ExecutionSession; calls: Call[] } {
   const calls: Call[] = [];
   const session: ExecutionSession = {
      id: 's',
      exec: async (command: string, options?: ExecOptions) => {
         calls.push({ command, cwd: options?.cwd, timeoutMs: options?.timeoutMs });
         const result = handler(command);
         if (result instanceof Error) throw result;
         return { stdout: '', stderr: '', exitCode: 0, ...result } as ExecResult;
      },
      stream: () => ({ async *[Symbol.asyncIterator]() {} }),
      writeFile: async () => undefined,
      readFile: async () => '',
      stop: async () => undefined,
      destroy: async () => undefined,
   };
   return { session, calls };
}

/** Advances a fixed amount on every read, so durations are deterministic. */
function tickingClock(stepMs: number): () => Date {
   let now = 0;
   return () => new Date((now += stepMs));
}

test('every command runs in the checkout, in the order given', async () => {
   const { session, calls } = fakeSession(() => ({ exitCode: 0 }));
   const report = await verify({
      session,
      directory: 'frontend',
      commands: ['pnpm lint', 'pnpm test'],
   });

   assert.equal(report.passed, true);
   assert.equal(report.complete, true);
   assert.deepEqual(
      calls.map((call) => [call.command, call.cwd]),
      [
         ['pnpm lint', 'frontend'],
         ['pnpm test', 'frontend'],
      ]
   );
});

test('a failing check is recorded and does not stop the ones after it', async () => {
   // The reviewer needs the whole picture, not the first thing that broke.
   const { session } = fakeSession((command) =>
      command.includes('lint') ? { exitCode: 1, stderr: '3 problems\n' } : { exitCode: 0 }
   );
   const report = await verify({
      session,
      directory: 'f',
      commands: ['pnpm lint', 'pnpm test'],
   });

   assert.equal(report.passed, false);
   assert.equal(report.results.length, 2);
   assert.equal(report.results[0]?.passed, false);
   assert.equal(report.results[0]?.exitCode, 1);
   assert.match(report.results[0]?.output ?? '', /3 problems/);
   assert.equal(report.results[1]?.passed, true);
});

test('a check that could not run is not a check that passed', async () => {
   // The substrate breaking is a different fact from the command failing, and
   // recording it as exit 0 would be evidence of something that never ran.
   const { session } = fakeSession(() => new Error('container evicted'));
   const report = await verify({ session, directory: 'f', commands: ['pnpm test'] });

   assert.equal(report.passed, false);
   assert.equal(report.results[0]?.exitCode, null);
   assert.equal(report.results[0]?.passed, false);
   assert.equal(report.results[0]?.error, 'container evicted');
});

test('a set cut short by the budget says so and does not report as passed', async () => {
   // Two commands that each consume the whole budget: the second never runs.
   const { session, calls } = fakeSession(() => ({ exitCode: 0 }));
   const report = await verify({
      session,
      directory: 'f',
      commands: ['first', 'second', 'third'],
      totalBudgetMs: 150,
      clock: tickingClock(100),
   });

   assert.equal(report.complete, false);
   assert.equal(report.passed, false, 'an incomplete set must not read as passing');
   assert.ok(calls.length < 3, `expected the set to stop early, ran ${calls.length}`);
});

test('no command may outlast what is left of the budget', async () => {
   const { session, calls } = fakeSession(() => ({ exitCode: 0 }));
   await verify({
      session,
      directory: 'f',
      commands: ['a', 'b'],
      commandTimeoutMs: 60_000,
      totalBudgetMs: 10_000,
      clock: tickingClock(1_000),
   });
   for (const call of calls) {
      assert.ok((call.timeoutMs ?? Infinity) <= 10_000, `unbounded: ${call.timeoutMs}`);
   }
});

test('no commands means no evidence, which is not a pass', async () => {
   // Every project starts here. A weaker pull request, not a broken one — but
   // "passed" would be a claim about checks that do not exist.
   const { session, calls } = fakeSession(() => ({ exitCode: 0 }));
   const report = await verify({ session, directory: 'f', commands: [] });
   assert.equal(report.results.length, 0);
   assert.equal(report.passed, false);
   assert.equal(calls.length, 0);
});

test('blank entries are skipped rather than run as empty commands', async () => {
   const { session, calls } = fakeSession(() => ({ exitCode: 0 }));
   const report = await verify({ session, directory: 'f', commands: ['  ', 'pnpm test', ''] });
   assert.equal(calls.length, 1);
   assert.equal(report.results.length, 1);
});

test('output is the tail, bounded, and says when it was cut', async () => {
   const { session } = fakeSession(() => ({
      stdout: 'x'.repeat(20_000),
      stderr: 'FAILED: the last line\n',
      exitCode: 1,
   }));
   const report = await verify({ session, directory: 'f', commands: ['pnpm test'] });
   const output = report.results[0]!.output;

   assert.ok(output.length < 5_000, 'the whole log was kept');
   assert.match(output, /FAILED: the last line/);
   assert.match(output, /earlier output omitted/);
});

test('the summary reads as a reviewer would want it', () => {
   const summary = summarise({
      passed: false,
      complete: false,
      durationMs: 5_000,
      results: [
         { command: 'pnpm lint', exitCode: 0, passed: true, durationMs: 900, output: '', error: null },
         { command: 'pnpm test', exitCode: 1, passed: false, durationMs: 2_400, output: '', error: null },
         { command: 'e2e', exitCode: null, passed: false, durationMs: 0, output: '', error: 'evicted' },
      ],
   });

   assert.match(summary, /`pnpm lint` — passed in 900ms/);
   assert.match(summary, /`pnpm test` — failed \(exit 1\) in 2\.4s/);
   assert.match(summary, /`e2e` — could not run: evicted/);
   // An incomplete set says so, rather than letting a reader assume the rest
   // passed silently.
   assert.match(summary, /remaining checks did not run/);
});

test('an empty report has nothing to say', () => {
   assert.equal(summarise({ passed: false, complete: true, durationMs: 0, results: [] }), '');
});
