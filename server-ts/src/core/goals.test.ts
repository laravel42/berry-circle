import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GoalRepository, InvalidTransition, canTransition, type GoalStatus } from './goals.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Goals against a real PostgreSQL. The lifecycle is the part worth testing
 * hardest: it decides what a goal may become, and getting it wrong lets a
 * finished goal reopen — which leaves every count and every event that
 * described it as finished wrong.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

test('the lifecycle is draft → planned → active ⇄ blocked → terminal', () => {
   assert.ok(canTransition('draft', 'planned'));
   assert.ok(canTransition('draft', 'active'));
   assert.ok(canTransition('planned', 'active'));
   assert.ok(canTransition('active', 'blocked'));
   assert.ok(canTransition('blocked', 'active'));
   assert.ok(canTransition('active', 'completed'));

   // Terminal means terminal. A cancelled goal that could reopen would make
   // every completion count a guess.
   for (const to of ['draft', 'planned', 'active', 'blocked'] as GoalStatus[]) {
      assert.ok(!canTransition('completed', to), `completed → ${to}`);
      assert.ok(!canTransition('cancelled', to), `cancelled → ${to}`);
   }
   // Nor may a goal skip straight to planned from active, or go backwards.
   assert.ok(!canTransition('active', 'planned'));
   assert.ok(!canTransition('planned', 'draft'));
});

describe('goals', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let goals: GoalRepository;
   const fixture = { workspaceId: '', boardId: '', userId: '', otherId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      goals = new GoalRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   const now = () => new Date().toISOString();
   const make = (title: string) =>
      goals.create({
         workspaceId: fixture.workspaceId,
         title,
         createdBy: fixture.userId,
         createdAt: now(),
      });

   test('a goal starts as a draft nobody wrote by machine', async () => {
      const { goal, event } = await make('Ship the thing');
      assert.equal(goal.status, 'draft');
      assert.equal(goal.source, 'manual');
      assert.equal(goal.startedAt, null);
      assert.equal(goal.completedAt, null);
      assert.equal(event.type, 'goal.created');

      assert.deepEqual(await goals.get(goal.id), goal);
   });

   test('starting stamps startedAt, and returning from blocked does not restart it', async () => {
      const { goal } = await make('Lifecycle');
      const started = await goals.transition(goal.id, 'active', fixture.userId, now());
      assert.equal(started.event!.type, 'goal.started');
      assert.notEqual(started.goal.startedAt, null);

      const blocked = await goals.transition(goal.id, 'blocked', fixture.userId, now());
      // `blocked` is a pause, not an end: goal.updated rather than a lifecycle
      // topic, and the original start survives it.
      assert.equal(blocked.event!.type, 'goal.updated');
      assert.equal(blocked.goal.startedAt, started.goal.startedAt);

      const resumed = await goals.transition(goal.id, 'active', fixture.userId, now());
      // Not a second beginning — a consumer counting starts must not count it.
      assert.equal(resumed.event!.type, 'goal.updated');
      assert.equal(resumed.goal.startedAt, started.goal.startedAt);
   });

   test('completing stamps completedAt and cancelling clears it', async () => {
      const finished = await make('Finish');
      await goals.transition(finished.goal.id, 'active', fixture.userId, now());
      const done = await goals.transition(finished.goal.id, 'completed', fixture.userId, now());
      assert.equal(done.event!.type, 'goal.completed');
      assert.notEqual(done.goal.completedAt, null);

      const dropped = await make('Drop');
      const cancelled = await goals.transition(dropped.goal.id, 'cancelled', fixture.userId, now());
      assert.equal(cancelled.event!.type, 'goal.cancelled');
      // A cancelled goal was never completed, so it carries no completion time.
      assert.equal(cancelled.goal.completedAt, null);
   });

   test('asking for the status it already has is agreement, not a conflict', async () => {
      const { goal } = await make('Idempotent');
      const again = await goals.transition(goal.id, 'draft', fixture.userId, now());
      assert.equal(again.goal.status, 'draft');
      // No event, because nothing happened — publishing one would tell every
      // open board a goal changed when it did not.
      assert.equal(again.event, null);
   });

   test('a move the lifecycle forbids names both ends', async () => {
      const { goal } = await make('Refused');
      await goals.transition(goal.id, 'cancelled', fixture.userId, now());
      await assert.rejects(
         () => goals.transition(goal.id, 'active', fixture.userId, now()),
         (error: unknown) =>
            error instanceof InvalidTransition && error.from === 'cancelled' && error.to === 'active'
      );
   });

   test('a patch names what changed and leaves the rest alone', async () => {
      const { goal } = await goals.create({
         workspaceId: fixture.workspaceId,
         title: 'Before',
         description: 'Original.',
         createdBy: fixture.userId,
         createdAt: now(),
      });
      const updated = await goals.update(goal.id, { title: 'After' }, fixture.userId, now());
      assert.equal(updated.goal.title, 'After');
      assert.equal(updated.goal.description, 'Original.');
      assert.deepEqual(JSON.parse(updated.event.payload).changedFields, ['title']);

      // Setting a field to the value it already has is not a change: a
      // consumer re-renders on the named fields, and naming one that did not
      // move makes it re-render for nothing.
      const same = await goals.update(goal.id, { title: 'After' }, fixture.userId, now());
      assert.deepEqual(JSON.parse(same.event.payload).changedFields, []);
   });

   test('an issue belongs to at most one goal, so linking moves it', async () => {
      const first = await make('First owner');
      const second = await make('Second owner');
      const issueId = await createIssue(sql, fixture, 'Contested');

      for (const goal of [first.goal, second.goal]) {
         await goals.linkIssue({
            workspaceId: fixture.workspaceId,
            goalId: goal.id,
            issueId,
            actorId: fixture.userId,
            now: now(),
         });
      }
      assert.deepEqual((await goals.listIssues(first.goal.id)).map((i) => i.id), []);
      assert.deepEqual((await goals.listIssues(second.goal.id)).map((i) => i.id), [issueId]);
   });

   test('progress counts the work and hides what was deleted', async () => {
      const { goal } = await make('Counted');
      const open = await createIssue(sql, fixture, 'Open');
      const done = await createIssue(sql, fixture, 'Done');
      const gone = await createIssue(sql, fixture, 'Gone');
      for (const issueId of [open, done, gone]) {
         await goals.linkIssue({
            workspaceId: fixture.workspaceId, goalId: goal.id, issueId,
            actorId: fixture.userId, now: now(),
         });
      }
      await sql`UPDATE issues SET status = 'done' WHERE id = ${done}`;
      await sql`UPDATE issues SET deleted_at = now() WHERE id = ${gone}`;

      const progress = await goals.progress(goal.id);
      assert.equal(progress.issuesTotal, 2);
      assert.equal(progress.issuesDone, 1);
      assert.equal(progress.issuesCancelled, 0);
      // The link survives the delete; the count does not, because a deleted
      // issue is not work anybody is going to do.
      assert.deepEqual((await goals.listIssues(goal.id)).map((i) => i.title).sort(), ['Done', 'Open']);
   });

   test('unlinking an issue that was not linked is a not-found', async () => {
      const { goal } = await make('Detach');
      const issueId = await createIssue(sql, fixture, 'Unlinked');
      await assert.rejects(() => goals.unlinkIssue(goal.id, issueId), NotFound);
   });

   test('an archived goal is gone from reads but its events survive', async () => {
      const { goal } = await make('Retire');
      const event = await goals.archive(goal.id, fixture.userId, now());
      assert.equal(event.type, 'goal.archived');
      await assert.rejects(() => goals.get(goal.id), NotFound);

      const listed = await goals.list(
         fixture.workspaceId, { query: '', status: null, projectId: null }, null, 100);
      assert.ok(!listed.some((item) => item.id === goal.id));
   });

   test('every goal fact is relayed as a jsonb object with no board', async () => {
      const { goal } = await make('Relayed');
      await goals.transition(goal.id, 'active', fixture.userId, now());

      const rows = await sql`
         SELECT topic, jsonb_typeof(payload) AS kind, board_id, payload
           FROM outbox_events WHERE aggregate_id = ${goal.id} ORDER BY occurred_at`;
      assert.deepEqual(rows.map((r) => r.topic), ['goal.created', 'goal.started']);
      for (const row of rows) {
         assert.equal(row.kind, 'object');
         // A goal belongs to no board, which is what keeps it out of the board
         // replay's partial index and in the workspace stream.
         assert.equal(row.board_id, null);
      }
      assert.equal((rows[0]!.payload as Record<string, unknown>).aggregateType, 'goal');
   });

   test('a viewer may read goals and may not write them', async () => {
      const scope = await goals.authorizeWorkspace(fixture.otherId, fixture.workspaceId, 'product.read');
      assert.equal(scope.role, 'viewer');
      await assert.rejects(
         () => goals.authorizeWorkspace(fixture.otherId, fixture.workspaceId, 'product.write'),
         Forbidden
      );
   });

   test('the page is newest-updated first and resumes where it stopped', async () => {
      const workspaceId = await freshWorkspace(sql, fixture.userId);
      const created = [];
      for (const title of ['one', 'two', 'three']) {
         created.push(
            (await goals.create({ workspaceId, title, createdBy: fixture.userId, createdAt: now() })).goal
         );
      }
      const filter = { query: '', status: null, projectId: null };
      const first = await goals.list(workspaceId, filter, null, 2);
      assert.deepEqual(first.map((g) => g.title), ['three', 'two']);

      const last = first.at(-1)!;
      const second = await goals.list(workspaceId, filter, { updatedAt: last.updatedAt, id: last.id }, 10);
      assert.deepEqual(second.map((g) => g.title), ['one']);

      await sql`DELETE FROM outbox_events WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM goals WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`;
      await deleteWorkspaceAgents(sql, [workspaceId]);
      await deleteWorkspaceBoards(sql, [workspaceId]);
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
   });
});

async function createIssue(sql: Sql, fixture: Record<string, string>, title: string): Promise<string> {
   const id = randomUUID();
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${fixture.boardId!}
      RETURNING issue_counter`;
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${id}, ${fixture.boardId!}, ${Number(counter!.issue_counter)}, ${title}, ${fixture.userId!})`;
   return id;
}

async function freshWorkspace(sql: Sql, ownerId: string): Promise<string> {
   const suffix = randomUUID().slice(0, 8);
   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Goals ${suffix}`}, ${`goals-${suffix}`},
              ${sql.json({ issuePrefix: 'GOL', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${ownerId})
      RETURNING id`;
   const workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}, ${ownerId}, 'owner')`;
   return workspaceId;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`goals-${suffix}@berry.test`}, 'Goal Owner') RETURNING id`;
   fixture.userId = user!.id as string;
   const [other] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`viewer-${suffix}@berry.test`}, 'Viewer') RETURNING id`;
   fixture.otherId = other!.id as string;

   fixture.workspaceId = await freshWorkspace(sql, fixture.userId);
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.otherId}, 'viewer')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Goals', ${`gol-${suffix}`}, ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
   await sql`DELETE FROM goals WHERE workspace_id = ${fixture.workspaceId}`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   for (const id of [fixture.userId, fixture.otherId]) {
      if (id) await sql`DELETE FROM users WHERE id = ${id}`;
   }
}
