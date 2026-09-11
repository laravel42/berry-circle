import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { PullRequestStore, type PullRequestInput } from './pull-requests.ts';
import { insertBoard } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Pull requests against issues, on a real database.
 *
 * Real SQL because the guarantees are about which rows a webhook may touch:
 * an issue number that exists in two workspaces must only ever be linked in
 * the one the webhook was routed to.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

interface Tenant {
   workspaceId: string;
   boardId: string;
   agentId: string;
   issues: string[];
}

describe(
   'pull requests recorded against issues',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let store: PullRequestStore;
      let userId = '';
      const tenants: Tenant[] = [];
      let githubId = 900_000_000 + Math.floor(Math.random() * 1_000_000);

      async function tenant(): Promise<Tenant> {
         const suffix = randomUUID().slice(0, 8);
         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`PR ${suffix}`}, ${`pr-${suffix}`},
                    ${sql.json({ issuePrefix: 'PRS', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${userId})
            RETURNING id`;
         const workspaceId = workspace!.id as string;
         const boardId = await insertBoard(sql, {
            workspaceId,
            createdBy: userId,
            name: 'PRs',
            slug: `prb-${suffix}`,
         });
         const [agent] = await sql`
            INSERT INTO agents (id, workspace_id, board_id, name, status)
            VALUES (${randomUUID()}, ${workspaceId}, ${boardId}, 'Forge', 'available')
            RETURNING id`;
         const created: Tenant = { workspaceId, boardId, agentId: agent!.id as string, issues: [] };
         for (let index = 0; index < 3; index += 1) {
            const [counter] = await sql`
               UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
               RETURNING issue_counter`;
            const [issue] = await sql`
               INSERT INTO issues (id, board_id, number, title, created_by)
               VALUES (${randomUUID()}, ${boardId}, ${Number(counter!.issue_counter)}, 'Task', ${userId})
               RETURNING id`;
            created.issues.push(issue!.id as string);
         }
         tenants.push(created);
         return created;
      }

      function pullRequest(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
         githubId += 1;
         return {
            githubId,
            repoId: 4242,
            repoFullName: 'acme/api',
            number: githubId % 10_000,
            title: 'A change',
            url: 'https://github.com/acme/api/pull/1',
            state: 'open',
            draft: false,
            headRef: 'feature/unrelated',
            headSha: `sha-${githubId}`,
            authorLogin: 'octo',
            mergedAt: null,
            closedAt: null,
            githubUpdatedAt: '2026-09-10T10:00:00Z',
            body: null,
            ...overrides,
         };
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         store = new PullRequestStore({ sql, issues: new IssueRepository(sql) });
         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`prs-${randomUUID().slice(0, 8)}@berry.test`}, 'PR tester')
            RETURNING id`;
         userId = user!.id as string;
      });

      after(async () => {
         if (!sql) return;
         for (const { workspaceId } of tenants) {
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM runs WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${workspaceId})`;
            await sql`DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${workspaceId})`;
            await deleteWorkspaceAgents(sql, [workspaceId]);
            await sql`DELETE FROM boards WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
         }
         if (userId) await sql`DELETE FROM users WHERE id = ${userId}`;
         await closeDatabase(sql);
      });

      test('a late retry cannot roll a merged pull request back to open', async () => {
         const { workspaceId } = await tenant();
         const merged = pullRequest({
            state: 'merged',
            mergedAt: '2026-09-10T11:00:00Z',
            githubUpdatedAt: '2026-09-10T11:00:00Z',
         });
         const first = await store.upsertPullRequest(workspaceId, merged);
         const late = await store.upsertPullRequest(workspaceId, {
            ...merged,
            state: 'open',
            mergedAt: null,
            githubUpdatedAt: '2026-09-10T10:00:00Z',
         });
         assert.equal(late.id, first.id);
         assert.equal(late.stale, true);
         const [row] = await sql`SELECT state FROM github_pull_requests WHERE id = ${first.id}`;
         assert.equal(row?.state, 'merged');
      });

      test('a key links only the issue in the workspace the webhook belongs to', async () => {
         const w1 = await tenant();
         const w2 = await tenant();
         const pr = pullRequest({ title: 'PRS-1 tidy' });
         const { id } = await store.upsertPullRequest(w1.workspaceId, pr);
         const linked = await store.linkIssues(w1.workspaceId, id, pr, { autoLink: true });
         assert.deepEqual(linked, [w1.issues[0]]);
         assert.ok(!linked.includes(w2.issues[0]!), 'the same number in another workspace is never linked');
      });

      test('with auto-link off, only the branch Berry wrote for a run links', async () => {
         const w = await tenant();
         const [run] = await sql`
            INSERT INTO runs (id, issue_id, board_id, agent_id, requested_by, status, completed_at)
            VALUES (${randomUUID()}, ${w.issues[1]!}, ${w.boardId}, ${w.agentId}, ${userId},
                    'succeeded', now())
            RETURNING id`;
         await sql`UPDATE runs SET branch = 'forge/prs-2-thing' WHERE id = ${run!.id as string}`;
         const pr = pullRequest({ headRef: 'forge/prs-2-thing', title: 'PRS-1 as well' });
         const { id } = await store.upsertPullRequest(w.workspaceId, pr);
         const linked = await store.linkIssues(w.workspaceId, id, pr, { autoLink: false });
         assert.deepEqual(linked, [w.issues[1]]);
      });

      test('a merged pull request that closes an issue moves it to done', async () => {
         const w = await tenant();
         const issueId = w.issues[2]!;
         await sql`UPDATE issues SET status = 'in_progress' WHERE id = ${issueId}`;
         const pr = pullRequest({ body: 'Fixes PRS-3', state: 'merged', mergedAt: '2026-09-10T12:00:00Z' });
         const { id } = await store.upsertPullRequest(w.workspaceId, pr);
         await store.linkIssues(w.workspaceId, id, pr, { autoLink: true });
         const closed = await store.closeLinkedIssues(w.workspaceId, id, userId);
         assert.deepEqual(closed, [issueId]);
         const [issue] = await sql`SELECT status::text AS status FROM issues WHERE id = ${issueId}`;
         assert.equal(issue?.status, 'done');
         const completed = await sql`
            SELECT 1 FROM outbox_events WHERE topic = 'issue.completed' AND aggregate_id = ${issueId}`;
         assert.equal(completed.length, 1);
      });

      test('an issue’s pull requests carry their checks, and a foreign issue reads as absent', async () => {
         const w1 = await tenant();
         const w2 = await tenant();
         const pr = pullRequest({ title: 'PRS-1 again' });
         const { id } = await store.upsertPullRequest(w1.workspaceId, pr);
         await store.linkIssues(w1.workspaceId, id, pr, { autoLink: true });
         const touched = await store.upsertCheck(w1.workspaceId, {
            kind: 'run',
            githubId: pr.githubId,
            repoId: pr.repoId,
            headSha: pr.headSha!,
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            url: null,
         });
         assert.deepEqual(touched, [w1.issues[0]]);

         const listed = await store.listForIssue(w1.workspaceId, w1.issues[0]!);
         assert.equal(listed?.length, 1);
         assert.equal(listed?.[0]?.checks.rollup, 'failure');
         assert.equal(await store.listForIssue(w1.workspaceId, w2.issues[0]!), null);
      });
   }
);
