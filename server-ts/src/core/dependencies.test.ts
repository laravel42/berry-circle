import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { DependencyCycle, DependencyRepository } from './dependencies.ts';
import { ReviewRepository } from './reviews.ts';
import { NotFound } from '../identity/errors.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Dependencies and AutoGate verdicts against a real PostgreSQL. Almost every
 * rule here is the database's — a trigger refuses cycles, a foreign key
 * refuses cross-workspace edges — so a fake would be testing nothing.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue relations', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let dependencies: DependencyRepository;
   let reviews: ReviewRepository;
   const fixture = { workspaceId: '', boardId: '', userId: '', agentId: '', peerId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      dependencies = new DependencyRepository(sql);
      reviews = new ReviewRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   const now = () => new Date().toISOString();
   const edge = (issueId: string, dependsOnIssueId: string) =>
      dependencies.add({
         workspaceId: fixture.workspaceId,
         issueId,
         dependsOnIssueId,
         createdBy: fixture.userId,
         createdAt: now(),
      });

   test('one edge is read from both ends', async () => {
      const waiter = await createIssue(sql, fixture, 'Waits');
      const blocker = await createIssue(sql, fixture, 'Blocks');
      await edge(waiter, blocker);

      const fromWaiter = await dependencies.list(waiter);
      assert.deepEqual(fromWaiter.dependsOn.map((r) => r.title), ['Blocks']);
      assert.deepEqual(fromWaiter.blocks, []);

      // The table is symmetric, so which side an issue is on decides which
      // list it lands in — the same row, read the other way round.
      const fromBlocker = await dependencies.list(blocker);
      assert.deepEqual(fromBlocker.blocks.map((r) => r.title), ['Waits']);
      assert.deepEqual(fromBlocker.dependsOn, []);
   });

   test('a reference carries the identifier and status a reader needs', async () => {
      const waiter = await createIssue(sql, fixture, 'Reader');
      const blocker = await createIssue(sql, fixture, 'Referenced');
      await sql`UPDATE issues SET status = 'in_progress' WHERE id = ${blocker}`;
      await edge(waiter, blocker);

      const [ref] = (await dependencies.list(waiter)).dependsOn;
      assert.match(ref!.identifier, /^DEP-\d+$/);
      // camelCase on the wire, underscores in the enum.
      assert.equal(ref!.status, 'inProgress');
   });

   test('asking twice for the same ordering is the same request', async () => {
      const waiter = await createIssue(sql, fixture, 'Twice');
      const blocker = await createIssue(sql, fixture, 'Once');
      await edge(waiter, blocker);
      await edge(waiter, blocker);
      assert.equal((await dependencies.list(waiter)).dependsOn.length, 1);
   });

   test('an issue may not wait on itself, directly or round a loop', async () => {
      const first = await createIssue(sql, fixture, 'First');
      const second = await createIssue(sql, fixture, 'Second');
      await assert.rejects(() => edge(first, first), DependencyCycle);

      await edge(first, second);
      // The trigger catches the loop; nothing in this repository walks the
      // graph, which is why the check has to survive the port intact.
      await assert.rejects(() => edge(second, first), DependencyCycle);
   });

   test('an edge to an issue that does not exist is refused', async () => {
      const waiter = await createIssue(sql, fixture, 'Hopeful');
      await assert.rejects(() => edge(waiter, randomUUID()), NotFound);
   });

   test('a deleted issue disappears from both lists', async () => {
      // Every issue read hides deleted issues, and a dependency list showing
      // one would offer a link to a page that no longer opens.
      const waiter = await createIssue(sql, fixture, 'Survivor');
      const blocker = await createIssue(sql, fixture, 'Removed');
      await edge(waiter, blocker);
      await sql`UPDATE issues SET deleted_at = now() WHERE id = ${blocker}`;
      assert.deepEqual((await dependencies.list(waiter)).dependsOn, []);
   });

   test('removing an edge that is not there is a not-found', async () => {
      const waiter = await createIssue(sql, fixture, 'Detach');
      const blocker = await createIssue(sql, fixture, 'Detached');
      await edge(waiter, blocker);

      await dependencies.remove(waiter, blocker);
      assert.deepEqual((await dependencies.list(waiter)).dependsOn, []);
      await assert.rejects(() => dependencies.remove(waiter, blocker), NotFound);
   });

   test('a verdict is readable, and an undecided one says it is still reading', async () => {
      // The failure this route exists for: a rejected review left the task in
      // review with the reason recorded and no surface showing it.
      const issueId = await createIssue(sql, fixture, 'Reviewed');
      const runId = await createRun(sql, fixture, issueId);
      await sql`
         INSERT INTO issue_auto_reviews (
            id, workspace_id, issue_id, run_id, reviewer_id, author_id,
            approved, reason, attempt, started_at, decided_at
         ) VALUES (
            ${randomUUID()}, ${fixture.workspaceId}, ${issueId}, ${runId},
            ${fixture.peerId}, ${fixture.agentId},
            false, 'The tests are missing.', 1, now(), now()
         )`;

      const [decided] = await reviews.list(issueId);
      assert.equal(decided!.approved, false);
      assert.equal(decided!.inProgress, false);
      assert.equal(decided!.reason, 'The tests are missing.');
      assert.equal(decided!.reviewer, 'Reviewer');
      assert.notEqual(decided!.decidedAt, null);
   });

   test('a reserved review is shown before the reviewer answers', async () => {
      // The row is reserved when the reviewer is picked so it can be shown;
      // for the length of the call a task under review looked exactly like a
      // task nobody had reached.
      const issueId = await createIssue(sql, fixture, 'In review');
      const runId = await createRun(sql, fixture, issueId);
      await sql`
         INSERT INTO issue_auto_reviews (
            id, workspace_id, issue_id, run_id, reviewer_id, author_id, attempt, started_at
         ) VALUES (
            ${randomUUID()}, ${fixture.workspaceId}, ${issueId}, ${runId},
            ${fixture.peerId}, ${fixture.agentId}, 1, now()
         )`;

      const [pending] = await reviews.list(issueId);
      assert.equal(pending!.approved, null);
      assert.equal(pending!.inProgress, true);
      assert.equal(pending!.reason, '');
   });

   test('an issue with no verdicts reads as none, not as an error', async () => {
      const issueId = await createIssue(sql, fixture, 'Unreviewed');
      assert.deepEqual(await reviews.list(issueId), []);
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

async function createRun(sql: Sql, fixture: Record<string, string>, issueId: string): Promise<string> {
   const id = randomUUID();
   await sql`
      INSERT INTO runs (id, issue_id, board_id, agent_id, requested_by, status, completed_at)
      VALUES (${id}, ${issueId}, ${fixture.boardId!}, ${fixture.agentId!}, ${fixture.userId!},
              'succeeded', now())`;
   return id;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   const [user] = await sql`
      INSERT INTO users (id, email, name)
      VALUES (${randomUUID()}, ${`deps-${suffix}@berry.test`}, 'Deps') RETURNING id`;
   fixture.userId = user!.id as string;

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Deps ${suffix}`}, ${`deps-${suffix}`},
              ${sql.json({ issuePrefix: 'DEP', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.userId})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;
   await sql`
      INSERT INTO workspace_memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Deps', ${`dep-${suffix}`}, ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;

   // Two agents, because issue_auto_reviews_peer_ck refuses a row whose
   // reviewer is its author. The rule that an agent never reviews its own work
   // is enforced by the schema, not only by the service that writes it.
   const [author] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, status)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId},
              'Author', 'available')
      RETURNING id`;
   fixture.agentId = author!.id as string;
   const [peer] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, status)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId},
              'Reviewer', 'available')
      RETURNING id`;
   fixture.peerId = peer!.id as string;
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   await sql`DELETE FROM users WHERE id = ${fixture.userId!}`;
}
