import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { nullRunMemory } from '../agentcore/memory.ts';
import { ScriptedModel, say, type ScriptedTurn } from '../agents/runtime/scripted-model.ts';
import { inProcessTransport } from '../agents/runtime/container/in-process-transport.ts';
import { SessionRegistry } from '../agents/runtime/container/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import { enqueueTask } from '../runs/queue.ts';
import { EnvelopeBuilder } from './envelope-builder.ts';
import type { LifecycleEvent } from './lifecycle.ts';
import { RuntimeTaskExecutor, type UsageRecorder } from './task-executor.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';
import type { RuntimeTarget, RuntimeTransport } from './transport.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const TARGET: RuntimeTarget = { id: null, driver: 'http', arn: null, qualifier: 'DEFAULT', region: null, endpointUrl: 'http://test' };

function scripted(events: LifecycleEvent[], stopped: string[] = []): RuntimeTransport {
   return {
      async *invoke() {
         for (const event of events) yield event;
      },
      async stop({ runtimeSessionId }) {
         stopped.push(runtimeSessionId);
      },
   };
}

describe('runtime task executor', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   const usage: Array<Parameters<UsageRecorder>[1]> = [];
   const recordUsage: UsageRecorder = async (_sql, input) => void usage.push(input);

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'executor');
   });
   afterEach(async () => {
      usage.length = 0;
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   const builder = () =>
      new EnvelopeBuilder({
         sql, publicUrl: 'https://berry.test', defaultModel: 'scripted', memory: nullRunMemory(), sealer: null,
         github: (token) => new GitHubClient({ token }),
      });
   const executor = (transport: RuntimeTransport) =>
      new RuntimeTaskExecutor({ sql, transport, builder: builder(), defaultTarget: TARGET, recordUsage, memory: nullRunMemory() });

   async function issueTask(): Promise<{ runId: string; issueId: string }> {
      const issueId = await createIssue(sql, fixture!);
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId: fixture!.agentId, issueId, kind: 'agent', source: 'assignment',
      });
      return { runId, issueId };
   }

   test('the real runtime handler drives an issue run to succeeded, with events and usage', async () => {
      const { runId, issueId } = await issueTask();
      const transport = inProcessTransport({
         registry: new SessionRegistry(),
         modelFactory: () => new ScriptedModel([say('The fix is in.')] as ScriptedTurn[]),
         region: 'us-east-1',
         workRoot: mkdtempSync(join(tmpdir(), 'berry-exec-')),
         loadTools: async () => [],
      });
      const outcome = await executor(transport).execute(runId);
      assert.equal(outcome.status, 'succeeded');
      const [run] = await sql`SELECT status, summary, input_tokens, runtime_session_id FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'succeeded');
      assert.equal(run!.summary, 'The fix is in.');
      assert.ok(Number(run!.input_tokens) > 0);
      assert.match(run!.runtime_session_id as string, /^berry-[0-9a-f]{64}$/);
      const types = (await sql`SELECT event_type FROM run_events WHERE run_id = ${runId} ORDER BY sequence`).map((r) => r.event_type);
      assert.ok(types.includes('run.started') && types.includes('run.output.delta') && types.includes('run.completed'));
      assert.equal(usage.length, 1);
      assert.equal(usage[0]!.agentId, fixture!.agentId);
      const [issue] = await sql`SELECT status, active_run_id FROM issues WHERE id = ${issueId}`;
      assert.deepEqual({ ...issue }, { status: 'in_review', active_run_id: null });
      const tokens = await sql`SELECT revoked_at FROM task_tokens WHERE run_id = ${runId}`;
      assert.ok(tokens.every((t) => t.revoked_at !== null));
   });

   test('a stream that ends without a verdict is RUNTIME_STREAM_ENDED, retryable', async () => {
      const { runId } = await issueTask();
      const outcome = await executor(scripted([{ type: 'task.started' }])).execute(runId);
      assert.equal(outcome.status, 'failed');
      assert.deepEqual(outcome.failure, {
         code: 'RUNTIME_STREAM_ENDED',
         message: 'The runtime stopped reporting before the task finished.',
         retryable: true,
      });
   });

   test('task.failed from the runtime is recorded as sent', async () => {
      const { runId } = await issueTask();
      const outcome = await executor(
         scripted([{ type: 'task.started' }, { type: 'task.failed', failure: { code: 'MODEL_REFUSED', message: 'no', retryable: false } }])
      ).execute(runId);
      assert.equal(outcome.failure?.code, 'MODEL_REFUSED');
   });

   test('a cancelled run stops the runtime session', async () => {
      const { runId } = await issueTask();
      const stopped: string[] = [];
      const controller = new AbortController();
      const hanging: RuntimeTransport = {
         async *invoke({ signal }) {
            yield { type: 'task.started' } as LifecycleEvent;
            controller.abort();
            // Aborted just above: a listener added to an already-aborted
            // signal never fires, so waiting unconditionally would hang the test.
            if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
         },
         async stop({ runtimeSessionId }) {
            stopped.push(runtimeSessionId);
         },
      };
      const outcome = await executor(hanging).execute(runId, controller.signal);
      assert.equal(outcome.status, 'cancelled');
      assert.equal(stopped.length, 1);
   });

   test('a completion task stores its result and writes no run events', async () => {
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture!.workspaceId, agentId: fixture!.orchestratorId, kind: 'completion', source: 'completion', prompt: 'x',
      });
      await sql`UPDATE runs SET completion_spec = ${sql.json({ purpose: 't', system: 's', jsonSchema: null, model: null } as never)} WHERE id = ${runId}`;
      const outcome = await executor(
         scripted([
            { type: 'task.started' },
            { type: 'task.usage', usage: { model: 'm', inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
            { type: 'task.completed', result: { text: 'hi', truncated: false, structured: { a: 1 }, delivery: null } },
         ])
      ).execute(runId);
      assert.equal(outcome.status, 'succeeded');
      const [run] = await sql`SELECT status, result, total_tokens FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'succeeded');
      assert.deepEqual((run!.result as { structured: unknown }).structured, { a: 1 });
      assert.equal(Number(run!.total_tokens), 5);
      const events = await sql`SELECT 1 FROM run_events WHERE run_id = ${runId}`;
      assert.equal(events.length, 0);
   });
});
