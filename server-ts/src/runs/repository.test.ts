import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { ActiveRunExists, NoAgentAssigned, RunRepository } from './repository.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Reading the ledger, and the one write that starts a run.
 *
 * Like the ledger's own tests these need a real PostgreSQL, and for the same
 * reason: what is being asserted is what the database does. `admit` is a
 * transaction with a row lock in it, the paging guarantee is a tuple
 * comparison PostgreSQL evaluates, and a fake would agree with whatever this
 * code happened to do.
 *
 * Gated on BERRY_TEST_DATABASE_URL so `npm test` stays runnable without one.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('run repository', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let runs: RunRepository;
   const fixture = { workspaceId: '', boardId: '', agentId: '', otherAgentId: '', userId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      runs = new RunRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   // Each test gets its own issue, so an active run left by one cannot decide
   // the outcome of the next.
   let issueId = '';
   beforeEach(async () => {
      issueId = await createIssue(sql, fixture);
   });

   test('admitting writes the assignment, the run and its first event together', async () => {
      const run = await runs.admit({
         issueId,
         boardId: fixture.boardId!,
         workspaceId: fixture.workspaceId!,
         agentId: fixture.agentId!,
         requestedBy: fixture.userId!,
         instructions: 'Run the gateway suite first.',
      });

      assert.equal(run.status, 'queued');
      assert.equal(run.agentId, fixture.agentId);
      assert.equal(run.issueId, issueId);
      assert.equal(run.workspaceId, fixture.workspaceId);
      assert.equal(run.sequence, 0);
      assert.equal(run.startedAt, null);
      assert.equal(run.failure, null);

      const [issue] = await sql`
         SELECT assignee_type, assignee_id, active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.assignee_type, 'agent');
      assert.equal(issue!.assignee_id, fixture.agentId);
      assert.equal(issue!.active_run_id, run.id);

      // Sequence 0, because this is the event that starts the sequence rather
      // than one appended to it. The ledger's allocator begins at 1.
      const events = await runs.events(run.id, null, 10);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'run.created');
      assert.equal(events[0]!.sequence, 0);
      assert.deepEqual(events[0]!.payload, { agentId: fixture.agentId });
   });

   test('an unassigned task cannot be run, and nothing is left behind', async () => {
      await assert.rejects(
         () =>
            runs.admit({
               issueId,
               boardId: fixture.boardId!,
               workspaceId: fixture.workspaceId!,
               agentId: null,
               requestedBy: fixture.userId!,
               instructions: null,
            }),
         NoAgentAssigned
      );

      const [count] = await sql`SELECT count(*)::int AS n FROM runs WHERE issue_id = ${issueId}`;
      assert.equal(count!.n, 0);
   });

   test('a task already assigned to an agent needs no agentId', async () => {
      await sql`
         UPDATE issues SET assignee_type = 'agent', assignee_id = ${fixture.agentId!}
          WHERE id = ${issueId}`;

      const run = await runs.admit({
         issueId,
         boardId: fixture.boardId!,
         workspaceId: fixture.workspaceId!,
         agentId: null,
         requestedBy: fixture.userId!,
         instructions: null,
      });
      assert.equal(run.agentId, fixture.agentId);
   });

   test('a task with a run in progress is refused, and told which run', async () => {
      const first = await admit(runs, fixture, issueId);

      await assert.rejects(
         () => admit(runs, fixture, issueId),
         (error: unknown) => {
            assert.ok(error instanceof ActiveRunExists);
            // The id is given so a client can go to the run rather than guess
            // why its request was refused.
            assert.equal(error.runId, first.id);
            return true;
         }
      );
   });

   test('a refused second request does not reassign the task', async () => {
      // The assignment is applied before the active-run check, so this is the
      // case the transaction exists for: a refusal must leave the task with
      // the agent that is actually running it.
      const first = await admit(runs, fixture, issueId);

      await assert.rejects(
         () => admit(runs, fixture, issueId, fixture.otherAgentId!),
         ActiveRunExists
      );

      const [issue] = await sql`SELECT assignee_id, active_run_id FROM issues WHERE id = ${issueId}`;
      assert.equal(issue!.assignee_id, fixture.agentId);
      assert.equal(issue!.active_run_id, first.id);
   });

   test('once a run has finished the task can be run again', async () => {
      const first = await admit(runs, fixture, issueId);
      await sql`UPDATE runs SET status = 'cancelled', completed_at = now() WHERE id = ${first.id}`;

      const second = await admit(runs, fixture, issueId);
      assert.notEqual(second.id, first.id);
      assert.equal(second.status, 'queued');
   });

   test('a task that does not exist is not found rather than created', async () => {
      await assert.rejects(
         () =>
            runs.admit({
               issueId: randomUUID(),
               boardId: fixture.boardId!,
               workspaceId: fixture.workspaceId!,
               agentId: fixture.agentId!,
               requestedBy: fixture.userId!,
               instructions: null,
            }),
         NotFound
      );
   });

   test('runs come back newest first, and page without skipping a tie', async () => {
      // Its own board, so the page is exactly these three runs and not
      // whatever the tests before it left on the shared one.
      const boardId = await createBoard(sql, fixture, 'tie');

      // Three runs sharing one timestamp: the ordering can only be decided by
      // the id, which is exactly what the cursor carries.
      const created: string[] = [];
      for (let index = 0; index < 3; index += 1) {
         const own = await createIssue(sql, fixture, boardId);
         created.push((await admit(runs, { ...fixture, boardId }, own)).id);
      }
      await sql`UPDATE runs SET created_at = '2026-01-01T00:00:00Z' WHERE id = ANY(${created})`;

      const expected = [...created].sort().reverse();

      const first = await runs.listByBoard(boardId, null, 2);
      assert.deepEqual(
         first.map((run) => run.id),
         expected.slice(0, 2)
      );

      const last = first.at(-1)!;
      const rest = await runs.listByBoard(boardId, { createdAt: last.createdAt, id: last.id }, 2);
      assert.deepEqual(
         rest.map((run) => run.id),
         expected.slice(2)
      );
   });

   test('a status filter narrows the listing to that status', async () => {
      const done = await admit(runs, fixture, issueId);
      await sql`UPDATE runs SET status = 'succeeded', completed_at = now() WHERE id = ${done.id}`;
      const queued = await admit(runs, fixture, issueId);

      const succeeded = await runs.listByIssue(issueId, null, 10, { status: 'succeeded' });
      assert.deepEqual(
         succeeded.map((run) => run.id),
         [done.id]
      );
      const pending = await runs.listByIssue(issueId, null, 10, { status: 'queued' });
      assert.deepEqual(
         pending.map((run) => run.id),
         [queued.id]
      );
   });

   test('an agent filter selects that agent, on the board listing', async () => {
      const mine = await admit(runs, fixture, issueId);
      const theirs = await admit(runs, fixture, await createIssue(sql, fixture), fixture.otherAgentId!);

      const found = await runs.listByBoard(fixture.boardId!, null, 10, {
         agentId: fixture.otherAgentId!,
      });
      const ids = found.map((run) => run.id);
      assert.ok(ids.includes(theirs.id));
      assert.ok(!ids.includes(mine.id));
   });

   test('a listing is scoped to its own board and its own task', async () => {
      const run = await admit(runs, fixture, issueId);
      const elsewhere = await runs.listByIssue(await createIssue(sql, fixture), null, 10);
      assert.deepEqual(elsewhere, []);
      assert.deepEqual((await runs.listByBoard(randomUUID(), null, 10)).length, 0);
      assert.ok((await runs.listByBoard(fixture.boardId!, null, 50)).some((r) => r.id === run.id));
   });

   test('after is exclusive, so a reconnecting reader gets what followed', async () => {
      const run = await admit(runs, fixture, issueId);
      await appendEvent(sql, fixture, run, issueId, 1, 'run.started', true);
      await appendEvent(sql, fixture, run, issueId, 2, 'run.completed', true);

      const all = await runs.events(run.id, null, 10);
      assert.deepEqual(
         all.map((event) => event.sequence),
         [0, 1, 2]
      );

      const rest = await runs.events(run.id, 0, 10);
      assert.deepEqual(
         rest.map((event) => event.sequence),
         [1, 2]
      );
      assert.deepEqual(await runs.events(run.id, 2, 10), []);
   });

   test('a private event is not part of the stream a person watches', async () => {
      const run = await admit(runs, fixture, issueId);
      await appendEvent(sql, fixture, run, issueId, 1, 'run.internal', false);

      const events = await runs.events(run.id, null, 10);
      assert.deepEqual(
         events.map((event) => event.sequence),
         [0]
      );
   });

   test('a run that does not exist is not found', async () => {
      await assert.rejects(() => runs.get(randomUUID()), NotFound);
   });
});

// ------------------------------------------------------------------ fixture

function admit(
   runs: RunRepository,
   fixture: Record<string, string>,
   issueId: string,
   agentId = fixture.agentId!
) {
   return runs.admit({
      issueId,
      boardId: fixture.boardId!,
      workspaceId: fixture.workspaceId!,
      agentId,
      requestedBy: fixture.userId!,
      instructions: null,
   });
}

async function appendEvent(
   sql: Sql,
   fixture: Record<string, string>,
   run: { id: string },
   issueId: string,
   sequence: number,
   type: string,
   isPublic: boolean
): Promise<void> {
   await sql`
      INSERT INTO run_events (id, run_id, board_id, issue_id, sequence, event_type, payload, public)
      VALUES (${randomUUID()}, ${run.id}, ${fixture.boardId!}, ${issueId}, ${sequence},
              ${type}, ${sql.json({} as never)}, ${isPublic})`;
}

async function createIssue(
   sql: Sql,
   fixture: Record<string, string>,
   boardId = fixture.boardId!
): Promise<string> {
   const issueId = randomUUID();
   await sql.begin(async (tx) => {
      const [counter] = await tx`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${boardId} RETURNING issue_counter`;
      await tx`
         INSERT INTO issues (id, board_id, number, title, status, created_by)
         VALUES (${issueId}, ${boardId}, ${Number(counter!.issue_counter)},
                 'Repository task', 'todo', ${fixture.userId!})`;
   });
   return issueId;
}

async function createBoard(
   sql: Sql,
   fixture: Record<string, string>,
   slug: string
): Promise<string> {
   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId!}, ${`Board ${slug}`},
              ${`${slug}-${randomUUID().slice(0, 6)}`}, ${fixture.userId!})
      RETURNING id`;
   return board!.id as string;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`runrepo-${suffix}@berry.test`}, 'Run Repo Test')
      RETURNING id`;
   fixture.userId = user!.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Runs ${suffix}`}, ${`runs-${suffix}`},
              ${sql.json({ issuePrefix: 'RUN', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.userId})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;

   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Runs board', ${`run-${suffix}`},
              ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;

   for (const [key, name] of [
      ['agentId', 'Forge'],
      ['otherAgentId', 'Scout'],
   ] as const) {
      const [agent] = await sql`
         INSERT INTO agents (id, workspace_id, board_id, name, instructions)
         VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId}, ${name}, 'Be brief.')
         RETURNING id`;
      fixture[key] = agent!.id as string;
   }
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`
      DELETE FROM issues
       WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${fixture.workspaceId})`;
   // A workspace provisions a protected Orchestrator by trigger, and protected
   // agents refuse deletion — deliberately. Suspended here and only here, for
   // the fixture's own teardown.
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId!}`;
}
