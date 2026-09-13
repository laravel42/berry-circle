import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { Dispatcher, type Executor } from './dispatcher.ts';
import { RunRepository } from './repository.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * What turns a queued run into a running one.
 *
 * The executor is a fake — what is under test is the claiming, the lease and
 * the sweep, none of which care what the agent does. The database is real,
 * because all three are SQL: `SKIP LOCKED` is what makes two dispatchers safe,
 * and the sweep's boundary is an interval comparison PostgreSQL evaluates.
 *
 * Gated on BERRY_TEST_DATABASE_URL so `npm test` stays runnable without one.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

/** Nothing is scheduled: every test drives the dispatcher a beat at a time. */
const MANUAL = { pollMs: 3_600_000, heartbeatMs: 3_600_000 };

/** This file's own workspace. Every dispatcher built here is confined to it. */
const fixture = { workspaceId: '', boardId: '', agentId: '', userId: '' };

describe('run dispatcher', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let runs: RunRepository;

   before(async () => {
      sql = openDatabase({ url: url! });
      runs = new RunRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   let issueId = '';
   beforeEach(async () => {
      // Every dispatcher here is confined to this file's workspace, so a test
      // asserting *which* run was claimed is asserting about its own fixture
      // and nobody else's — the files share one database and run at once.
      //
      // The drain is this workspace's own leftovers: a run an earlier test in
      // this file left queued is still claimable by the next one's dispatcher.
      await drain(sql, fixture);
      issueId = await createIssue(sql, fixture);
   });

   test('a confined dispatcher leaves another workspace’s runs alone', async () => {
      // What makes this suite safe beside the others: a dispatcher told which
      // workspaces it serves neither claims nor sweeps outside them.
      const theirs = { workspaceId: '', boardId: '', agentId: '', userId: '' };
      await seed(sql, theirs);
      try {
         const claimable = await admit(runs, theirs, await createIssue(sql, theirs));
         const abandoned = await admit(runs, theirs, await createIssue(sql, theirs));
         await sql`
            UPDATE runs
               SET status = 'running', dispatch_state = 'streaming',
                   dispatch_lease_until = now() - interval '1 minute'
             WHERE id = ${abandoned.id}`;

         const executed: string[] = [];
         const dispatcher = build(sql, {
            execute: async (runId) => {
               executed.push(runId);
               await settle(sql, runId, 'succeeded');
               return {};
            },
         });
         await drive(dispatcher);
         await dispatcher.stop();

         assert.deepEqual(executed, [], 'it claimed a run outside its workspaces');
         assert.equal((await runs.get(claimable.id)).status, 'queued');
         assert.equal((await runs.get(abandoned.id)).status, 'running');
      } finally {
         await cleanup(sql, theirs);
      }
   });

   test('a queued run is executed, and only once', async () => {
      const run = await admit(runs, fixture, issueId);
      const executed: string[] = [];
      const dispatcher = build(sql, {
         execute: async (runId) => {
            executed.push(runId);
            await settle(sql, runId, 'succeeded');
            return { status: 'succeeded' };
         },
      });

      await drive(dispatcher);
      assert.deepEqual(executed, [run.id]);

      // A second beat must not find it again: it is no longer queued.
      await drive(dispatcher);
      assert.deepEqual(executed, [run.id]);
   });

   test('two dispatchers over one run means one of them loses', async () => {
      await admit(runs, fixture, issueId);
      const claimed: string[] = [];
      const executor: Executor = {
         execute: async (runId) => {
            claimed.push(runId);
            await settle(sql, runId, 'succeeded');
            return {};
         },
      };

      // Started together, which is the case `SKIP LOCKED` exists for.
      await Promise.all([drive(build(sql, executor)), drive(build(sql, executor))]);
      assert.equal(claimed.length, 1);
   });

   test('no more runs are taken than the process will execute at once', async () => {
      const held: Array<() => void> = [];
      for (let index = 0; index < 4; index += 1) {
         await admit(runs, fixture, await createIssue(sql, fixture));
      }

      const dispatcher = build(
         sql,
         { execute: () => new Promise<unknown>((resolve) => held.push(() => resolve({}))) },
         { concurrency: 2 }
      );

      await tick(dispatcher);
      assert.equal(dispatcher.inflight, 2);

      // A second beat with both slots full takes nothing more.
      await tick(dispatcher);
      assert.equal(dispatcher.inflight, 2);

      for (const release of held) release();
      await dispatcher.stop();
   });

   test('a claim is oldest first, because a queue that is not is not one', async () => {
      const older = await admit(runs, fixture, issueId);
      const newer = await admit(runs, fixture, await createIssue(sql, fixture));
      await sql`UPDATE runs SET created_at = now() - interval '1 hour' WHERE id = ${older.id}`;

      const executed: string[] = [];
      const dispatcher = build(
         sql,
         {
            execute: async (runId) => {
               executed.push(runId);
               await settle(sql, runId, 'succeeded');
               return {};
            },
         },
         { concurrency: 1 }
      );

      await drive(dispatcher);
      await drive(dispatcher);
      assert.deepEqual(executed, [older.id, newer.id]);
   });

   test('cancelling a run in flight stops the work behind it', async () => {
      // The ledger marks the run cancelled on its own; what is asserted here
      // is that the process still doing the work finds out.
      const run = await admit(runs, fixture, issueId);
      let aborted = false;

      const dispatcher = build(sql, {
         execute: (runId, signal) =>
            new Promise<unknown>((resolve) => {
               signal?.addEventListener('abort', () => {
                  aborted = true;
                  resolve({});
               });
               void runId;
            }),
      });

      await tick(dispatcher);

      await sql`
         UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled', completed_at = now()
          WHERE id = ${run.id}`;
      // A beat on a run this process is not carrying does nothing, so this
      // aborting is also the proof that the run was claimed.
      await dispatcher.beat(run.id);

      assert.equal(aborted, true);
      await dispatcher.stop();
   });

   test('a lease is renewed while the work goes on', async () => {
      const run = await admit(runs, fixture, issueId);
      const dispatcher = build(sql, { execute: () => new Promise<unknown>(() => {}) });

      await tick(dispatcher);
      const [before] = await sql`SELECT dispatch_lease_until FROM runs WHERE id = ${run.id}`;

      await sql`UPDATE runs SET status = 'running', dispatch_state = 'streaming' WHERE id = ${run.id}`;
      await dispatcher.beat(run.id);
      const [renewed] = await sql`SELECT dispatch_lease_until FROM runs WHERE id = ${run.id}`;

      assert.ok(
         new Date(renewed!.dispatch_lease_until as string) >
            new Date(before!.dispatch_lease_until as string),
         'the lease was not moved forward'
      );
      await dispatcher.stop();
   });

   test('a run whose owner is gone is failed, and its task released', async () => {
      const run = await admit(runs, fixture, issueId);
      // What a dead process leaves: claimed, in flight, lease expired.
      await sql`
         UPDATE runs
            SET status = 'running', dispatch_state = 'streaming',
                dispatch_lease_until = now() - interval '1 minute'
          WHERE id = ${run.id}`;

      await drive(build(sql, { execute: async () => ({}) }));

      const failed = await runs.get(run.id);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.failure?.code, 'DISPATCH_ABANDONED');
      // Retryable: nothing about the work was wrong.
      assert.equal(failed.failure?.retryable, true);

      // Released, which is the point — a run nobody is working on must not
      // hold the task forever.
      const [issue] = await sql`SELECT active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.active_run_id, null);

      // And it reaches the stream a person watches.
      const events = await runs.events(run.id, null, 10);
      assert.equal(events.at(-1)?.type, 'run.failed');
   });

   test('a run waiting in the queue is not mistaken for an abandoned one', async () => {
      // Queued, never claimed, so no lease. The sweep must leave it alone —
      // failing the queue would be the worst possible bug here.
      const run = await admit(runs, fixture, issueId);
      await sql`UPDATE runs SET dispatch_lease_until = now() - interval '1 hour' WHERE id = ${run.id}`;

      const dispatcher = build(sql, { execute: () => new Promise<unknown>(() => {}) });
      await dispatcher.sweep();

      assert.equal((await runs.get(run.id)).status, 'queued');
      await dispatcher.stop();
   });

   test('a run this process is executing is never swept', async () => {
      const run = await admit(runs, fixture, issueId);
      const dispatcher = build(sql, { execute: () => new Promise<unknown>(() => {}) });
      await tick(dispatcher);

      // Its lease expires — a beat was missed, not the process. It is still
      // in flight here, and sweeping it would kill live work.
      await sql`
         UPDATE runs
            SET status = 'running', dispatch_state = 'streaming',
                dispatch_lease_until = now() - interval '1 minute'
          WHERE id = ${run.id}`;
      await dispatcher.sweep();

      assert.equal((await runs.get(run.id)).status, 'running');
      await dispatcher.stop();
   });

   test('stopping aborts the work and records nothing', async () => {
      // A process on its way out must not write a verdict it may not be able
      // to finish. The lease stops being renewed and the next sweep decides.
      const run = await admit(runs, fixture, issueId);
      let aborted = false;
      const dispatcher = build(sql, {
         execute: (_runId, signal) =>
            new Promise<unknown>((resolve) => {
               signal?.addEventListener('abort', () => {
                  aborted = true;
                  resolve({});
               });
            }),
      });

      await tick(dispatcher);
      await dispatcher.stop();

      assert.equal(aborted, true);
      assert.equal((await runs.get(run.id)).status, 'queued');
   });

   test('a failing executor does not stop the dispatcher', async () => {
      await admit(runs, fixture, issueId);
      const second = await admit(runs, fixture, await createIssue(sql, fixture));
      const seen: string[] = [];

      const dispatcher = build(
         sql,
         {
            execute: async (runId) => {
               seen.push(runId);
               await settle(sql, runId, 'failed');
               throw new Error('the model refused');
            },
         },
         { concurrency: 1 }
      );

      await drive(dispatcher);
      await drive(dispatcher);
      assert.equal(seen.length, 2);
      assert.ok(seen.includes(second.id), 'the dispatcher stopped after the first failure');
   });
});

// ------------------------------------------------------------------ fixture

function build(
   sql: Sql,
   executor: Executor,
   options: { concurrency?: number } = {}
): Dispatcher {
   return new Dispatcher({
      sql,
      executor,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      concurrency: options.concurrency ?? 4,
      // This file's workspace and no other. See `beforeEach`.
      workspaceIds: [fixture.workspaceId],
      ...MANUAL,
   });
}

/**
 * One beat, driven by hand, waited out.
 *
 * A run is registered in flight synchronously by `tick`, but the executor's
 * own promise settles whenever it settles — which for these fakes means a
 * database round-trip. Waiting for the dispatcher to go idle is what makes the
 * next assertion about the beat that just happened rather than a race with it.
 */
async function drive(dispatcher: Dispatcher): Promise<void> {
   await dispatcher.tick();
   await idle(dispatcher);
}

/** One beat, for a fake that never finishes. Nothing to wait for. */
function tick(dispatcher: Dispatcher): Promise<void> {
   return dispatcher.tick();
}

async function idle(dispatcher: Dispatcher, timeoutMs = 5_000): Promise<void> {
   const deadline = Date.now() + timeoutMs;
   while (dispatcher.inflight > 0) {
      if (Date.now() > deadline) throw new Error('the dispatcher never went idle');
      await new Promise((resolve) => setTimeout(resolve, 5));
   }
}

/** Ends every run of this workspace a later test could claim. See `beforeEach`. */
async function drain(sql: Sql, fixture: Record<string, string>): Promise<void> {
   await sql`
      UPDATE runs SET status = 'cancelled', dispatch_state = 'cancelled', completed_at = now()
       WHERE status IN ('queued', 'running') AND workspace_id = ${fixture.workspaceId!}`;
   await sql`
      UPDATE issues SET active_run_id = NULL
       WHERE active_run_id IS NOT NULL
         AND board_id IN (SELECT id FROM boards WHERE workspace_id = ${fixture.workspaceId!})`;
}

/** Moves a run out of `queued` the way the ledger would. */
async function settle(sql: Sql, runId: string, status: string): Promise<void> {
   await sql`
      UPDATE runs SET status = ${status}::run_status, dispatch_state = ${status},
                      completed_at = now()
       WHERE id = ${runId}`;
   await sql`UPDATE issues SET active_run_id = NULL WHERE active_run_id = ${runId}`;
}

function admit(runs: RunRepository, fixture: Record<string, string>, issueId: string) {
   return runs.admit({
      issueId,
      boardId: fixture.boardId!,
      workspaceId: fixture.workspaceId!,
      agentId: fixture.agentId!,
      requestedBy: fixture.userId!,
      instructions: null,
   });
}

async function createIssue(sql: Sql, fixture: Record<string, string>): Promise<string> {
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId!} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${fixture.boardId!}, ${Number(counter!.issue_counter)},
                 'Dispatcher task', 'todo', ${fixture.userId!})`;
   });
   return issueId;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`dispatch-${suffix}@berry.test`}, 'Dispatch Test')
      RETURNING id`;
   fixture.userId = user!.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Dispatch ${suffix}`}, ${`dispatch-${suffix}`},
              ${sql.json({ issuePrefix: 'DIS', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.userId})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;

   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Dispatch board', ${`dis-${suffix}`},
              ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;

   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, instructions)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId}, 'Forge', 'Be brief.')
      RETURNING id`;
   fixture.agentId = agent!.id as string;
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${fixture.workspaceId})`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId!}`;
}
