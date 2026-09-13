import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../runtime/test-fixture.ts';
import { Dispatcher } from './dispatcher.ts';
import { EnqueueRejected, enqueueTask } from './queue.ts';
import { ActiveRunExists } from './repository.ts';
import { ConversationRepository } from '../conversations/repository.ts';
import { NotFound } from '../identity/errors.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;
const MANUAL = { pollMs: 3_600_000, heartbeatMs: 3_600_000 };
const quiet = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

describe('task queue', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'queue');
   });
   afterEach(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
      await sql`DELETE FROM agent_runtimes WHERE workspace_id = ${fixture!.workspaceId}`;
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('an issue task is a queued run that holds the issue', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId,
         agentId: f.agentId,
         issueId,
         kind: 'agent',
         source: 'mention',
         prompt: 'look at this',
         priority: 3,
         requestedBy: f.userId,
      });
      const [run] = await sql`
         SELECT status, kind, source, prompt, priority, board_id, workspace_id, requested_by
           FROM runs WHERE id = ${runId}`;
      assert.deepEqual(
         { ...run },
         {
            status: 'queued',
            kind: 'agent',
            source: 'mention',
            prompt: 'look at this',
            priority: 3,
            board_id: f.boardId,
            workspace_id: f.workspaceId,
            // The person who asked, so what an agent files in this run carries
            // their name (runtime/agent-tools/core-tools.ts).
            requested_by: f.userId,
         }
      );
      const [issue] = await sql`SELECT active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.active_run_id, runId);
      const [created] = await sql`SELECT event_type FROM run_events WHERE run_id = ${runId} AND sequence = 0`;
      assert.equal(created!.event_type, 'run.created');
   });

   test('a second task on a busy issue is refused', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const input = { workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'assignment' } as const;
      await enqueueTask(sql, input);
      await assert.rejects(enqueueTask(sql, input), ActiveRunExists);
   });

   test('a completion task names no issue and writes no events', async () => {
      const f = fixture!;
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId,
         agentId: f.orchestratorId,
         kind: 'completion',
         source: 'completion',
         prompt: 'summarise',
      });
      const [run] = await sql`SELECT issue_id, kind FROM runs WHERE id = ${runId}`;
      assert.equal(run!.issue_id, null);
      const events = await sql`SELECT 1 FROM run_events WHERE run_id = ${runId}`;
      assert.equal(events.length, 0);
   });

   test('an agent task with no issue and no chat is refused by name', async () => {
      const f = fixture!;
      await assert.rejects(
         enqueueTask(sql, { workspaceId: f.workspaceId, agentId: f.agentId, kind: 'agent', source: 'mention' }),
         (error: unknown) => error instanceof EnqueueRejected && error.code === 'TASK_TARGET_REQUIRED'
      );
   });

   test('an agent from another workspace cannot be queued here', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      await assert.rejects(
         enqueueTask(sql, {
            workspaceId: f.workspaceId,
            agentId: randomUUID(),
            issueId,
            kind: 'agent',
            source: 'mention',
         }),
         (error: unknown) => error instanceof EnqueueRejected && error.code === 'AGENT_NOT_IN_WORKSPACE'
      );
   });

   test('enqueueTask joins a transaction it is handed', async () => {
      const f = fixture!;
      let runId = '';
      await sql
         .begin(async (tx) => {
            ({ runId } = await enqueueTask(tx as unknown as Sql, {
               workspaceId: f.workspaceId,
               agentId: f.orchestratorId,
               kind: 'completion',
               source: 'completion',
            }));
            throw new Error('roll back');
         })
         .catch(() => undefined);
      const rows = await sql`SELECT 1 FROM runs WHERE id = ${runId}`;
      assert.equal(rows.length, 0);
   });

   test('the dispatcher claims higher priority first', async () => {
      const f = fixture!;
      const low = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
         kind: 'agent', source: 'assignment', priority: 100,
      });
      const high = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
         kind: 'agent', source: 'assignment', priority: 200,
      });
      const executed: string[] = [];
      const dispatcher = new Dispatcher({
         sql, logger: quiet, workspaceIds: [f.workspaceId], concurrency: 1, ...MANUAL,
         executor: { execute: async (id) => void executed.push(id) },
      });
      await dispatcher.tick();
      assert.equal(executed[0], high.runId);
      assert.equal(executed.includes(low.runId), false);
   });

   test('a runtime at its concurrency limit gets no more work', async () => {
      const f = fixture!;
      const [runtime] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, concurrency_limit)
         VALUES (${f.workspaceId}, 'one-at-a-time', 'custom', 'http', 'http://rt:8080', 1)
         RETURNING id`;
      await sql`UPDATE agents SET runtime_id = ${runtime!.id} WHERE id = ${f.agentId}`;
      try {
         const busy = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 300,
         });
         await sql`UPDATE runs SET status = 'running', dispatch_state = 'dispatching', started_at = now(),
                          dispatch_lease_until = now() + interval '1 minute'
                    WHERE id = ${busy.runId}`;
         const waiting = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 300,
         });
         const executed: string[] = [];
         const dispatcher = new Dispatcher({
            sql, logger: quiet, workspaceIds: [f.workspaceId], concurrency: 5, ...MANUAL,
            executor: { execute: async (id) => void executed.push(id) },
         });
         await dispatcher.tick();
         assert.equal(executed.includes(waiting.runId), false);
      } finally {
         await sql`UPDATE agents SET runtime_id = NULL WHERE id = ${f.agentId}`;
      }
   });

   test('one tick never claims past a runtime limit', async () => {
      const f = fixture!;
      const [runtime] = await sql`
         INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, concurrency_limit)
         VALUES (${f.workspaceId}, 'single', 'custom', 'http', 'http://rt:8080', 1)
         RETURNING id`;
      await sql`UPDATE agents SET runtime_id = ${runtime!.id} WHERE id = ${f.agentId}`;
      try {
         const first = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 400,
         });
         const second = await enqueueTask(sql, {
            workspaceId: f.workspaceId, agentId: f.agentId, issueId: await createIssue(sql, f),
            kind: 'agent', source: 'assignment', priority: 400,
         });
         const executed: string[] = [];
         const dispatcher = new Dispatcher({
            sql, logger: quiet, workspaceIds: [f.workspaceId], concurrency: 5, ...MANUAL,
            executor: { execute: async (id) => void executed.push(id) },
         });
         await dispatcher.tick();
         // Both are idle candidates for a limit-1 runtime; only one may be claimed.
         assert.equal(executed.filter((id) => id === first.runId || id === second.runId).length, 1);
      } finally {
         await sql`UPDATE agents SET runtime_id = NULL WHERE id = ${f.agentId}`;
      }
   });
   test('a chat session runs its tasks one at a time, in order', async () => {
      const f = fixture!;
      const sessionId = await new ConversationRepository(sql).createSession({
         workspaceId: f.workspaceId,
         userId: f.userId,
         agentId: f.agentId,
         title: 'guard',
      });
      try {
         const chat = { workspaceId: f.workspaceId, agentId: f.agentId, kind: 'agent', source: 'chat', chatSessionId: sessionId } as const;
         // Serialized, not refused: chat may queue several tasks.
         const first = await enqueueTask(sql, { ...chat, prompt: 'one' });
         const second = await enqueueTask(sql, { ...chat, prompt: 'two' });
         const [session] = await sql`SELECT active_run_id FROM conversations WHERE id = ${sessionId}`;
         assert.equal(session!.active_run_id, first.runId);

         const executed: string[] = [];
         const dispatcher = new Dispatcher({
            sql, logger: quiet, workspaceIds: [f.workspaceId], concurrency: 5, ...MANUAL,
            executor: { execute: async (id) => void executed.push(id) },
         });
         await dispatcher.tick();
         assert.equal(executed.includes(first.runId), true);
         assert.equal(executed.includes(second.runId), false, 'the second task waits for the first');

         await sql`UPDATE runs SET status = 'succeeded', completed_at = now() WHERE id = ${first.runId}`;
         await dispatcher.tick();
         assert.equal(executed.includes(second.runId), true, 'the second task runs once the first has ended');
      } finally {
         await sql`DELETE FROM runs WHERE chat_session_id = ${sessionId}`;
         await sql`DELETE FROM conversations WHERE id = ${sessionId}`;
      }
   });

   test('a chat task for a session outside the workspace is not found', async () => {
      const f = fixture!;
      await assert.rejects(
         enqueueTask(sql, {
            workspaceId: f.workspaceId,
            agentId: f.agentId,
            kind: 'agent',
            source: 'chat',
            chatSessionId: randomUUID(),
         }),
         NotFound
      );
   });
});
