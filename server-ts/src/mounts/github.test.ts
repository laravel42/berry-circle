import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { GitHubSettingsRepository } from '../scm/github-settings.ts';
import { PullRequestStore } from '../scm/pull-requests.ts';
import { githubMounts } from './github.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * `/api/v1/github` through the real app shell, against a real database.
 *
 * The guarantees are the ones a settings page leans on: an owner can change
 * things, a member can read and is told it cannot change them, a malformed
 * body is refused without a write, and an issue in another workspace is as
 * absent as one that never existed.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   'the GitHub settings mount',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      const users: string[] = [];
      const workspaces: string[] = [];
      let ownerToken = '';
      let memberToken = '';
      let w1 = '';
      let w1Issue = '';
      let w2Issue = '';

      async function user(label: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`gh-${label}-${randomUUID().slice(0, 8)}@berry.test`}, ${label})
            RETURNING id`;
         users.push(row!.id as string);
         return row!.id as string;
      }

      async function workspaceWithIssue(ownerId: string): Promise<{ id: string; issueId: string }> {
         const suffix = randomUUID().slice(0, 8);
         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`GH ${suffix}`}, ${`gh-${suffix}`},
                    ${sql.json({ issuePrefix: 'GHM', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${ownerId})
            RETURNING id`;
         const id = workspace!.id as string;
         workspaces.push(id);
         await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${id}, ${ownerId}, 'owner')`;
         const [board] = await sql`
            INSERT INTO boards (id, workspace_id, name, slug, created_by)
            VALUES (${randomUUID()}, ${id}, 'GH', ${`ghb-${suffix}`}, ${ownerId}) RETURNING id`;
         const [counter] = await sql`
            UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${board!.id as string}
            RETURNING issue_counter`;
         const [issue] = await sql`
            INSERT INTO issues (id, board_id, number, title, created_by)
            VALUES (${randomUUID()}, ${board!.id as string}, ${Number(counter!.issue_counter)}, 'Task', ${ownerId})
            RETURNING id`;
         return { id, issueId: issue!.id as string };
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
         const registry = new Registry();
         registry.registerAll(
            githubMounts({
               sessions,
               sql,
               settings: new GitHubSettingsRepository(sql),
               pullRequests: new PullRequestStore({ sql, issues: new IssueRepository(sql) }),
               githubApp: null,
               connections: null,
            })
         );
         app = createApp(registry);

         const owner = await user('owner');
         const member = await user('member');
         const stranger = await user('stranger');
         const first = await workspaceWithIssue(owner);
         const second = await workspaceWithIssue(stranger);
         w1 = first.id;
         w1Issue = first.issueId;
         w2Issue = second.issueId;
         await sql`INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES (${w1}, ${member}, 'member')`;
         ownerToken = await issueTestToken(sql, owner);
         memberToken = await issueTestToken(sql, member);
      });

      after(async () => {
         if (!sql) return;
         for (const id of workspaces) {
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${id}`;
            await sql`DELETE FROM issues WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${id})`;
            await deleteWorkspaceAgents(sql, [id]);
            await sql`DELETE FROM boards WHERE workspace_id = ${id}`;
            await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${id}`;
            await sql`DELETE FROM workspaces WHERE id = ${id}`;
         }
         for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`;
         await closeDatabase(sql);
      });

      function call(token: string, method: string, path: string, body?: unknown): Promise<Response> {
         return Promise.resolve(
            app.request(`/api/v1/github/${w1}${path}`, {
               method,
               headers: {
                  authorization: `Bearer ${token}`,
                  ...(body === undefined ? {} : { 'content-type': 'application/json' }),
               },
               ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
         );
      }

      test('an owner reads the defaults and is told it may manage them', async () => {
         const response = await call(ownerToken, 'GET', '/settings');
         assert.equal(response.status, 200);
         const body = (await response.json()) as {
            settings: { enabled: boolean };
            canManage: boolean;
            connection: { installed: boolean; appConfigured: boolean };
         };
         assert.equal(body.settings.enabled, true);
         assert.equal(body.canManage, true);
         assert.equal(body.connection.installed, false);
         assert.equal(body.connection.appConfigured, false);
      });

      test('a member reads the settings read-only and cannot change them', async () => {
         const read = (await (await call(memberToken, 'GET', '/settings')).json()) as { canManage: boolean };
         assert.equal(read.canManage, false);
         const write = await call(memberToken, 'PATCH', '/settings', { enabled: false });
         assert.equal(write.status, 403);
         const [row] = await sql`SELECT 1 FROM github_workspace_settings WHERE workspace_id = ${w1}`;
         assert.equal(row, undefined, 'a refused write leaves no row behind');
      });

      test('a member is told 404 for a repository that is absent or another workspace\'s, and 403 only for this one', async () => {
         const suffix = randomUUID().slice(0, 8);
         const added = await call(ownerToken, 'POST', '/repositories', {
            repositories: [{ url: `https://github.com/berry/own-${suffix}` }],
         });
         assert.equal(added.status, 201);
         const own = ((await added.json()) as { repositories: Array<{ id: string }> }).repositories[0]!.id;
         const [theirs] = await new GitHubSettingsRepository(sql).addRepositories(
            workspaces[1]!,
            [{ url: `https://github.com/berry/their-${suffix}` }],
            users[2]!,
            sql
         );
         try {
            for (const [method, body] of [['PATCH', { description: 'mine now' }], ['DELETE', undefined]] as const) {
               assert.equal((await call(memberToken, method, `/repositories/${theirs!.id}`, body)).status, 404, `${method}: another workspace's`);
               assert.equal((await call(memberToken, method, `/repositories/${randomUUID()}`, body)).status, 404, `${method}: none at all`);
               assert.equal((await call(memberToken, method, `/repositories/${own}`, body)).status, 403, `${method}: this workspace's`);
            }
         } finally {
            await sql`DELETE FROM workspace_repositories WHERE id IN (${own}, ${theirs!.id})`;
         }
      });

      test('an unknown field or an empty change is refused', async () => {
         assert.equal((await call(ownerToken, 'PATCH', '/settings', { enabeld: false })).status, 422);
         assert.equal((await call(ownerToken, 'PATCH', '/settings', {})).status, 422);
      });

      test('an owner switches GitHub off, and it stays off', async () => {
         const response = await call(ownerToken, 'PATCH', '/settings', { enabled: false });
         assert.equal(response.status, 200);
         const read = (await (await call(ownerToken, 'GET', '/settings')).json()) as {
            settings: { enabled: boolean; coAuthorTrailer: boolean };
         };
         assert.equal(read.settings.enabled, false);
         assert.equal(read.settings.coAuthorTrailer, true);
         await call(ownerToken, 'PATCH', '/settings', { enabled: true });
      });

      test('repositories: a bad URL is refused, a good one added once', async () => {
         const bad = await call(ownerToken, 'POST', '/repositories', {
            repositories: [{ url: 'http://github.com/acme/api' }],
         });
         assert.equal(bad.status, 422);
         const added = await call(ownerToken, 'POST', '/repositories', {
            repositories: [{ url: 'https://github.com/acme/api/', description: 'API' }],
         });
         assert.equal(added.status, 201);
         const again = (await (
            await call(ownerToken, 'POST', '/repositories', {
               repositories: [{ url: 'https://github.com/acme/api' }],
            })
         ).json()) as { repositories: unknown[] };
         assert.deepEqual(again.repositories, []);
         const listed = (await (await call(memberToken, 'GET', '/repositories')).json()) as {
            repositories: Array<{ url: string; description: string }>;
         };
         assert.deepEqual(
            listed.repositories.map((row) => [row.url, row.description]),
            [['https://github.com/acme/api', 'API']]
         );
      });

      test('an issue in another workspace is not found; one here shows its pull requests', async () => {
         assert.equal((await call(ownerToken, 'GET', `/issues/${w2Issue}/pull-requests`)).status, 404);
         const own = await call(ownerToken, 'GET', `/issues/${w1Issue}/pull-requests`);
         assert.equal(own.status, 200);
         assert.deepEqual(await own.json(), { visible: true, pullRequests: [] });
      });

      test('the picker says when this deployment cannot hold a credential', async () => {
         const response = await call(ownerToken, 'GET', '/github-repositories');
         assert.equal(response.status, 503);
         assert.equal(((await call(memberToken, 'GET', '/github-repositories')).status), 403);
      });
   }
);
