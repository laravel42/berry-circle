import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { RunConflict, RunLedger, RunTerminal } from './ledger.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * The run ledger against a real PostgreSQL.
 *
 * These cannot be unit tests. Everything the ledger is for happens in the
 * database: the sequence is allocated by a SQL function, the ordering
 * guarantee is microsecond arithmetic PostgreSQL performs, and the jsonb
 * column is where a wrongly-encoded envelope stops looking wrong. A fake would
 * agree with whatever the code did.
 *
 * Gated on BERRY_TEST_DATABASE_URL so `npm test` stays runnable without one.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('run ledger', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let ledger: RunLedger;
   const fixture = {
      workspaceId: '',
      boardId: '',
      agentId: '',
      userId: '',
   };

   before(async () => {
      sql = openDatabase({ url: url! });
      ledger = new RunLedger({ sql });
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   test('a queued run is claimed once and refuses a second claimant', async () => {
      const { runId, issueId } = await createRun(sql, fixture, 'Write the release note.');

      const dispatch = await ledger.claimDispatch(runId);
      assert.equal(dispatch.runId, runId);
      assert.equal(dispatch.issueId, issueId);
      assert.equal(dispatch.workspaceId, fixture.workspaceId);
      assert.equal(dispatch.instructions, 'Write the release note.');
      assert.match(dispatch.issueIdentifier, /^[A-Z]+-\d+$/);

      // The whole point of the claim: two workers must not run one agent, or
      // the model is paid twice and every tool side effect happens twice.
      await assert.rejects(() => ledger.claimDispatch(runId), RunConflict);
   });

   test('a run writes the ledger Go writes, in order', async () => {
      const { runId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(runId);
      await ledger.markRunning(runId);
      await ledger.appendOutput(runId, 'progress', 'Looking at ');
      await ledger.appendOutput(runId, 'progress', 'the task.');
      await ledger.appendToolStarted(runId, 'call_1', 'write_file');
      await ledger.appendToolCompleted(runId, 'call_1', true);
      await ledger.completeSuccess({
         runId,
         summary: 'Done.',
         usage: {
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
            costMicros: null,
            currency: null,
         },
      });

      const events = await sql`
         SELECT sequence, event_type, payload, occurred_at
           FROM run_events WHERE run_id = ${runId} ORDER BY sequence`;
      assert.deepEqual(
         events.map((row) => row.event_type),
         [
            // Written when the run was created, at sequence 0.
            'run.created',
            'run.started',
            'run.output.delta',
            'run.output.delta',
            'run.tool.started',
            'run.tool.completed',
            'run.usage.updated',
            'run.completed',
         ]
      );
      // Allocated by berry_allocate_run_event_sequence, which starts at 1
      // because sequence 0 belongs to the run.created event the API writes.
      assert.deepEqual(
         events.map((row) => Number(row.sequence)),
         [0, 1, 2, 3, 4, 5, 6, 7]
      );

      // Replay by time has to agree with replay by sequence, or a client that
      // resumes from a timestamp gets events in a different order than one
      // resuming from a cursor.
      const times = events.map((row) => row.occurred_at as string);
      for (let index = 1; index < times.length; index += 1) {
         assert.ok(times[index]! > times[index - 1]!, `${times[index]} follows ${times[index - 1]}`);
      }

      assert.deepEqual(events[4]!.payload, {
         name: 'write_file',
         toolCallId: 'call_1',
         inputSummary: null,
      });
      assert.deepEqual(events[6]!.payload, {
         usage: {
            currency: null,
            costMicros: null,
            inputTokens: 120,
            outputTokens: 45,
            totalTokens: 165,
         },
      });

      const [run] = await sql`
         SELECT status::text AS status, summary, output, total_tokens, dispatch_state, completed_at
           FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'succeeded');
      assert.equal(run!.summary, 'Done.');
      // The deltas accumulate into the run's own transcript, not only events.
      assert.equal(run!.output, 'Looking at the task.');
      assert.equal(Number(run!.total_tokens), 165);
      assert.equal(run!.dispatch_state, 'succeeded');
      assert.notEqual(run!.completed_at, null);
   });

   test('every event is relayed as a jsonb object, never a quoted string', async () => {
      const { runId, issueId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(runId);
      await ledger.markRunning(runId);
      await ledger.completeSuccess({
         runId,
         summary: null,
         usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
            costMicros: null,
            currency: null,
         },
      });

      // The mistake this catches shipped once: passing text and casting it
      // with ::jsonb stores the whole envelope quoted and escaped. It reads as
      // valid jsonb to anything that checks only the column type, and every
      // consumer fails to decode it.
      const rows = await sql`
         SELECT topic, jsonb_typeof(payload) AS kind, payload
           FROM outbox_events WHERE payload->>'runId' = ${runId} ORDER BY occurred_at`;
      assert.ok(rows.length >= 4, `expected the run's relay rows, got ${rows.length}`);
      for (const row of rows) {
         assert.equal(row.kind, 'object', `${row.topic} relayed as ${row.kind}`);
      }

      const started = rows.find((row) => row.topic === 'run.started')!;
      const envelope = started.payload as Record<string, unknown>;
      assert.equal(envelope.workspaceId, fixture.workspaceId);
      assert.equal(envelope.boardId, fixture.boardId);
      assert.equal(envelope.issueId, issueId);
      assert.equal(typeof envelope.sequence, 'number');
      assert.match(envelope.occurredAt as string, /^\d{4}-\d{2}-\d{2}T.*Z$/);

      // The task moving to review reaches boards that never opened the run.
      const issueEvent = rows.find((row) => row.topic === 'issue.updated');
      assert.ok(issueEvent, 'a completed run announces the task moved');
      const payload = (issueEvent!.payload as Record<string, Record<string, unknown>>).payload!;
      assert.deepEqual(payload.changedFields, ['activeRunId', 'status']);
      assert.equal((payload.issue as Record<string, unknown>).status, 'inReview');
      assert.equal((payload.issue as Record<string, unknown>).activeRunId, null);
   });

   test('a completed run releases the task and can be started again', async () => {
      const { runId: first, issueId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(first);
      await ledger.markRunning(first);
      await ledger.completeSuccess({
         runId: first,
         summary: 'One.',
         usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costMicros: null,
            currency: null,
         },
      });

      const [issue] = await sql`
         SELECT status::text AS status, active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.status, 'in_review');
      assert.equal(issue!.active_run_id, null);

      // runs_one_active_per_issue_key refuses a second active run, so a run
      // that failed to release its task would block that task forever. This
      // is the assertion: a second run on the *same* task is now accepted.
      const second = randomUUID();
      await sql`
         INSERT INTO runs (id, issue_id, board_id, agent_id, requested_by)
         VALUES (${second}, ${issueId}, ${fixture.boardId!}, ${fixture.agentId!},
                 ${fixture.userId!})`;
      await sql`UPDATE issues SET active_run_id = ${second} WHERE id = ${issueId}`;
   });

   test('a terminal run refuses everything that follows', async () => {
      const { runId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(runId);
      await ledger.markRunning(runId);
      await ledger.fail({
         runId,
         failure: { code: 'RUNTIME_ERROR', message: 'the model refused', retryable: false },
      });

      const [run] = await sql`
         SELECT status::text AS status, failure_code, failure_message, failure_retryable,
                dispatch_state
           FROM runs WHERE id = ${runId}`;
      assert.equal(run!.status, 'failed');
      assert.equal(run!.failure_code, 'RUNTIME_ERROR');
      assert.equal(run!.failure_message, 'the model refused');
      assert.equal(run!.failure_retryable, false);
      assert.equal(run!.dispatch_state, 'failed');

      // An output delta arriving after the end is work from a stream that
      // should have stopped; recording it would extend a closed run.
      await assert.rejects(() => ledger.appendOutput(runId, 'progress', 'late'), RunTerminal);
      await assert.rejects(
         () =>
            ledger.completeSuccess({
               runId,
               summary: 'no',
               usage: {
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  costMicros: null,
                  currency: null,
               },
            }),
         RunTerminal
      );
   });

   test('cancelling is idempotent and releases the task', async () => {
      const { runId, issueId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(runId);
      await ledger.markRunning(runId);

      const cancelled = await ledger.markCancelled(runId);
      assert.equal(cancelled.status, 'cancelled');
      // Cancelling an already-cancelled run is what the caller wanted, so it
      // returns rather than throwing — a retried cancel must not fail.
      const again = await ledger.markCancelled(runId);
      assert.equal(again.status, 'cancelled');

      const [count] = await sql`
         SELECT count(*) AS total FROM run_events
          WHERE run_id = ${runId} AND event_type = 'run.cancelled'`;
      assert.equal(Number(count!.total), 1);

      const [issue] = await sql`SELECT active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.active_run_id, null);
   });

   test('concurrent appends never collide on the run sequence', async () => {
      const { runId } = await createRun(sql, fixture, null);
      await ledger.claimDispatch(runId);
      await ledger.markRunning(runId);

      // Reading MAX(sequence) inside a transaction does not stop two writers
      // from reading the same one at READ COMMITTED. The lock on the run row
      // is what serialises them, and this is the test that would catch its
      // removal — with a 23505 on run_events (run_id, sequence).
      await Promise.all(
         Array.from({ length: 12 }, (_, index) =>
            ledger.appendOutput(runId, 'progress', `chunk ${index} `)
         )
      );

      const rows = await sql`
         SELECT sequence FROM run_events
          WHERE run_id = ${runId} AND event_type = 'run.output.delta' ORDER BY sequence`;
      assert.equal(rows.length, 12);
      assert.equal(new Set(rows.map((row) => Number(row.sequence))).size, 12);

      const [run] = await sql`SELECT output FROM runs WHERE id = ${runId}`;
      // Every delta reached the transcript, whatever order they interleaved in.
      for (let index = 0; index < 12; index += 1) {
         assert.match(run!.output as string, new RegExp(`chunk ${index} `));
      }
      await ledger.markCancelled(runId);
   });
});

/** A workspace, board, issue and agent this file owns and deletes. */
async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`ledger-${suffix}@berry.test`}, 'Ledger Test')
      RETURNING id`;
   fixture.userId = user!.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Ledger ${suffix}`}, ${`ledger-${suffix}`},
              ${sql.json({ issuePrefix: 'LED', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.userId})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;

   // A board's creator has to be a member of its workspace — a trigger
   // enforces it against every writer, so a fixture that skips this fails at
   // the board, not at the membership.
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Ledger board', ${`led-${suffix}`},
              ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;

   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId},
              'Ledger Agent', 'Be brief.')
      RETURNING id`;
   fixture.agentId = agent!.id as string;
}

/**
 * A task with a queued run on it, as the API creates one.
 *
 * Each gets its own task because `runs_one_active_per_issue_key` allows one
 * active run per task — which is the constraint being relied on, not worked
 * around: a test that reused one task would fail on the second run for a
 * reason that has nothing to do with the ledger.
 *
 * `run.created` is written at sequence 0 without the allocator, which is why
 * the first allocated sequence is 1.
 */
async function createRun(
   sql: Sql,
   fixture: Record<string, string>,
   instructions: string | null
): Promise<{ runId: string; issueId: string }> {
   const runId = randomUUID();
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId!} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${fixture.boardId!}, ${Number(counter!.issue_counter)},
                 'Ledger task', 'in_progress', ${fixture.userId!})`;
      await tx`
         INSERT INTO runs (id, issue_id, board_id, agent_id, instructions, requested_by)
         VALUES (${runId}, ${issueId}, ${fixture.boardId!}, ${fixture.agentId!},
                 ${instructions}, ${fixture.userId!})`;
      await tx`UPDATE issues SET active_run_id = ${runId} WHERE id = ${issueId}`;
      await tx`
         INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
         VALUES (${randomUUID()}, ${runId}, ${fixture.boardId!}, ${issueId}, 0,
                 'run.created', ${tx.json({ run: { id: runId } } as never)}, true)`;
   });
   return { runId, issueId };
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   // Runs, events, comments and artifacts all cascade from the issue and the
   // board, so the workspace is the only root that has to be named.
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
   // Creating a workspace provisions a protected Orchestrator agent by
   // trigger, and protected agents refuse both deletion and unprotection —
   // deliberately, so no code path can remove a workspace's orchestrator.
   //
   // The guard is therefore suspended here and only here, for the fixture's
   // own teardown. Nothing under test is exempt from it; the alternative is a
   // test that leaves a workspace behind on every run.
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId!}`;
}
