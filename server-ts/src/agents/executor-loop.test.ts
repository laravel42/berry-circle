import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunExecutor } from './executor.ts';
import type { Sql } from '../db/pool.ts';
import type { Storage } from '../storage/storage.ts';
import { RunTerminal, type Dispatch, type RunLedger } from '../runs/ledger.ts';
import type { ExecutionDriver } from '../execution/driver.ts';
import { ScriptedModel, call, say, throwing } from './runtime/scripted-model.ts';

/**
 * The orchestration loop, offline.
 *
 * The model is scripted, the ledger is a fake and the database answers only
 * the two queries the loop makes before it starts — the agent row and the
 * last review. What is pinned is the shape of the run's ending: which ledger
 * call is made, with what, and that the workspace is always torn down.
 */

const dispatch: Dispatch = {
   runId: 'run-1',
   issueId: 'issue-1',
   boardId: 'board-1',
   workspaceId: 'ws-1',
   agentId: 'agent-1',
   issueTitle: 'Write the release note',
   issueDescription: null,
   issueIdentifier: 'BER-42',
   instructions: null,
   repository: '',
   requestId: '',
   traceParent: '',
};

/** A tagged template that answers by looking at the SQL text. */
function fakeSql(rows: { agent: Record<string, unknown> | null }): Sql {
   const sql = async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('FROM agents')) return rows.agent ? [rows.agent] : [];
      if (text.includes('issue_auto_reviews') || text.includes('FROM comments')) return [];
      throw new Error(`unexpected query: ${text}`);
   };
   return sql as unknown as Sql;
}

interface Recorded {
   method: string;
   args: unknown[];
}

function fakeLedger(options: { terminalOnSuccess?: boolean } = {}) {
   const calls: Recorded[] = [];
   const record =
      (method: string) =>
      async (...args: unknown[]) => {
         calls.push({ method, args });
         if (method === 'completeSuccess' && options.terminalOnSuccess) throw new RunTerminal();
         if (method === 'completeSuccess') return { summary: (args[0] as { summary: string }).summary };
         return undefined;
      };
   const ledger = {
      claimDispatch: async () => dispatch,
      markRunning: record('markRunning'),
      appendOutput: record('appendOutput'),
      appendToolStarted: record('appendToolStarted'),
      appendToolCompleted: record('appendToolCompleted'),
      completeSuccess: record('completeSuccess'),
      fail: record('fail'),
      markCancelled: record('markCancelled'),
   } as unknown as RunLedger;
   return { ledger, calls };
}

const agentRow = {
   id: 'agent-1',
   name: 'Writer',
   instructions: 'Be brief.',
   model_name: 'us.anthropic.test',
   permissions: ['read_repository'],
};

function executor(
   model: ScriptedModel,
   ledger: RunLedger,
   options: { sql?: Sql; execution?: ExecutionDriver } = {}
) {
   return new RunExecutor({
      sql: options.sql ?? fakeSql({ agent: agentRow }),
      storage: {} as unknown as Storage,
      ledger,
      region: 'us-east-1',
      modelFactory: () => model,
      newId: () => 'id',
      clock: () => new Date('2026-09-09T00:00:00Z'),
      ...(options.execution ? { execution: options.execution } : {}),
   });
}

test('a run that answers is recorded succeeded with its answer and its cost', async () => {
   const { ledger, calls } = fakeLedger();
   const long = 'Release note: ' + 'x'.repeat(400);
   const outcome = await executor(new ScriptedModel([say(long)]), ledger).execute('run-1');

   assert.equal(outcome.status, 'succeeded');
   assert.equal(outcome.summary, long);
   assert.equal(outcome.usage.inputTokens, 10);
   assert.ok(calls.some((c) => c.method === 'markRunning'));
   const success = calls.find((c) => c.method === 'completeSuccess');
   assert.equal((success?.args[0] as { summary: string }).summary, long);
   // The answer reached the ledger as progress before it became the summary.
   assert.ok(calls.some((c) => c.method === 'appendOutput' && String(c.args[2]).startsWith('Release')));
});

test('a model that keeps failing records a classified failure', async () => {
   const { ledger, calls } = fakeLedger();
   const rejected = Object.assign(new Error('bad model id'), {
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
   });
   const outcome = await executor(new ScriptedModel([throwing(rejected)]), ledger).execute('run-1');

   assert.equal(outcome.status, 'failed');
   assert.equal(outcome.failure?.code, 'UPSTREAM_REJECTED');
   assert.equal(outcome.failure?.retryable, false);
   assert.ok(calls.some((c) => c.method === 'fail'));
});

test('a cancel that lands before the first model call records cancelled, not a throw', async () => {
   const { ledger, calls } = fakeLedger();
   const controller = new AbortController();
   controller.abort();
   const outcome = await executor(new ScriptedModel([say('never')]), ledger).execute(
      'run-1',
      controller.signal
   );

   assert.equal(outcome.status, 'cancelled');
   assert.ok(calls.some((c) => c.method === 'markCancelled'));
   assert.ok(!calls.some((c) => c.method === 'completeSuccess'));
});

test('a run swept while completing keeps its summary and does not throw', async () => {
   const { ledger } = fakeLedger({ terminalOnSuccess: true });
   const outcome = await executor(new ScriptedModel([say('answer '.repeat(80))]), ledger).execute(
      'run-1'
   );
   assert.equal(outcome.status, 'cancelled');
   assert.ok(outcome.summary?.startsWith('answer'));
});

test('a denied tool reaches the model as a sentence and the run still ends', async () => {
   const { ledger, calls } = fakeLedger();
   const model = new ScriptedModel([
      call('run_command', { command: 'ls' }),
      say('I am not allowed to run commands. ' + 'z'.repeat(400)),
   ]);
   const driver = {
      createSession: async () => {
         throw new Error('must not be opened');
      },
      health: async () => ({ ok: true }),
   } as unknown as ExecutionDriver;
   const outcome = await executor(model, ledger, { execution: driver }).execute('run-1');

   assert.equal(outcome.status, 'succeeded');
   assert.ok(calls.some((c) => c.method === 'appendToolCompleted' && c.args[2] === false));
   assert.match(JSON.stringify(model.received[1]), /does not have permission to run commands/);
});

test('a thrown write_file fails the run instead of reporting a file that was never saved', async () => {
   const { ledger } = fakeLedger();
   const failing = async () => {
      throw new Error('storage is down');
   };
   // A database that throws on the artifact insert stands in for storage that
   // cannot take the file.
   const sql = (async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('FROM agents')) return [agentRow];
      if (text.includes('issue_auto_reviews') || text.includes('FROM comments')) return [];
      return failing();
   }) as unknown as Sql;
   const model = new ScriptedModel([call('write_file', { path: 'a.md', content: 'x' }), say('Saved it.')]);
   const outcome = executor(model, ledger, { sql });
   const result = await outcome.execute('run-1');
   assert.equal(result.status, 'failed');
   assert.equal(result.failure?.code, 'TOOL_FAILED');
});

test('an agent that no longer exists fails the run before anything is spent', async () => {
   const { ledger, calls } = fakeLedger();
   const exec = executor(new ScriptedModel([]), ledger, { sql: fakeSql({ agent: null }) });
   await assert.rejects(exec.execute('run-1'), /does not exist/);
   const failure = calls.find((c) => c.method === 'fail')?.args[0] as { failure: { code: string } };
   assert.equal(failure.failure.code, 'AGENT_UNAVAILABLE');
});
