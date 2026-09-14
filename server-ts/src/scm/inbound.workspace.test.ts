import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { enqueueTask } from '../runs/queue.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../runtime/test-fixture.ts';
import { ScmInbound } from './inbound.ts';
import type { ScmLinkRepository } from './links.ts';

/**
 * Regression: pull-request and review events matched reviews and runs by
 * branch name alone, so a delivery for one workspace's pull request could
 * rewrite another workspace's review and run that happened to share the
 * branch. They are now applied only inside the workspace that claimed the
 * webhook's installation.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const logger = { info: () => undefined, error: () => undefined, warn: () => undefined } as unknown as Logger;
const W1_INSTALLATION = 101;

interface Seeded {
   fixture: Fixture;
   runId: string;
   reviewId: string;
}

describe('pull-request events stay in their installation’s workspace', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let inbound: ScmInbound;
   // One branch name in both workspaces: Berry writes `berry/<n>-<agent>-<slug>`,
   // and nothing makes that unique across workspaces.
   const prBranch = `berry/1-agent-${randomUUID().slice(0, 8)}`;
   const reviewBranch = `berry/2-agent-${randomUUID().slice(0, 8)}`;
   const seeded: Record<'w1' | 'w2', Record<'pr' | 'review', Seeded>> = {} as never;
   const fixtures: Fixture[] = [];

   async function seed(fixture: Fixture, branch: string): Promise<Seeded> {
      const issueId = await createIssue(sql, fixture, 'Inbound scope');
      const { runId } = await enqueueTask(sql, {
         workspaceId: fixture.workspaceId, agentId: fixture.agentId, issueId, kind: 'agent', source: 'assignment',
      });
      await sql`UPDATE runs SET branch = ${branch} WHERE id = ${runId}`;
      const [review] = await sql`
         INSERT INTO reviews (workspace_id, issue_id, run_id, kind, state, title, branch)
         VALUES (${fixture.workspaceId}, ${issueId}, ${runId}, 'code', 'open', 'Review the change', ${branch})
         RETURNING id`;
      return { fixture, runId, reviewId: review!.id as string };
   }

   const reviewOf = async (row: Seeded) =>
      (await sql`SELECT state, pull_request_number FROM reviews WHERE id = ${row.reviewId}`)[0];
   const runPullRequest = async (row: Seeded) =>
      (await sql`SELECT pull_request_number FROM runs WHERE id = ${row.runId}`)[0]?.pull_request_number;

   before(async () => {
      sql = openDatabase({ url: url! });
      const w1 = await seedFixture(sql, 'inbound-w1');
      const w2 = await seedFixture(sql, 'inbound-w2');
      fixtures.push(w1, w2);
      seeded.w1 = { pr: await seed(w1, prBranch), review: await seed(w1, reviewBranch) };
      seeded.w2 = { pr: await seed(w2, prBranch), review: await seed(w2, reviewBranch) };
      inbound = new ScmInbound({
         sql,
         links: {} as ScmLinkRepository,
         logger,
         workspaceForInstallation: async (id) => (id === W1_INSTALLATION ? w1.workspaceId : null),
      });
   });
   after(async () => {
      for (const fixture of fixtures) {
         await sql`DELETE FROM reviews WHERE workspace_id = ${fixture.workspaceId}`;
         await sql`UPDATE issues SET active_run_id = NULL WHERE board_id = ${fixture.boardId}`;
         await sql`DELETE FROM runs WHERE workspace_id = ${fixture.workspaceId}`;
         await cleanupFixture(sql, fixture);
      }
      await closeDatabase(sql);
   });

   test('a merged pull request moves only its own workspace’s review and run', async () => {
      const result = await inbound.apply('pull_request', {
         installation: { id: W1_INSTALLATION },
         pull_request: { number: 42, merged: true, state: 'closed', head: { ref: prBranch } },
      });
      assert.equal(result.applied, true);
      assert.deepEqual({ ...(await reviewOf(seeded.w1.pr)) }, { state: 'merged', pull_request_number: '42' });
      assert.equal(await runPullRequest(seeded.w1.pr), '42');
      // The other workspace's review and run on the same branch are untouched.
      assert.deepEqual({ ...(await reviewOf(seeded.w2.pr)) }, { state: 'open', pull_request_number: null });
      assert.equal(await runPullRequest(seeded.w2.pr), null);
   });

   test('a review verdict decides only its own workspace’s review', async () => {
      const result = await inbound.apply('pull_request_review', {
         installation: { id: W1_INSTALLATION },
         pull_request: { head: { ref: reviewBranch } },
         review: { state: 'approved' },
      });
      assert.equal(result.applied, true);
      assert.equal((await reviewOf(seeded.w1.review))?.state, 'approved');
      assert.equal((await reviewOf(seeded.w2.review))?.state, 'open');
   });

   test('an unclaimed installation, or none at all, changes nothing anywhere', async () => {
      const pull = { number: 7, merged: false, state: 'closed', head: { ref: prBranch } };
      for (const payload of [
         { installation: { id: 999 }, pull_request: pull },
         { pull_request: pull },
      ]) {
         const result = await inbound.apply('pull_request', payload);
         assert.equal(result.applied, false);
         assert.match(result.reason, /not claimed/);
      }
      const verdict = await inbound.apply('pull_request_review', {
         installation: { id: 999 },
         pull_request: { head: { ref: reviewBranch } },
         review: { state: 'changes_requested' },
      });
      assert.equal(verdict.applied, false);
      assert.deepEqual({ ...(await reviewOf(seeded.w2.pr)) }, { state: 'open', pull_request_number: null });
      assert.equal((await reviewOf(seeded.w2.review))?.state, 'open');
   });
});
