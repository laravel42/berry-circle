import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { symmetricEncrypt } from 'better-auth/crypto';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { GitHubUserAccess } from '../integrations/github-user.ts';
import { GitHubSettingsRepository } from '../scm/github-settings.ts';
import { PullRequestStore } from '../scm/pull-requests.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { githubMounts } from './github.ts';

/**
 * Settings → Repositories, on a deployment with no App private key.
 *
 * The repositories a person granted are read with their own sign-in token and
 * recorded per workspace; these routes are how a page shows them and how someone
 * brings the list up to date after changing what the App can see on GitHub.
 *
 * The three answers that must never collapse into "no repositories" are all
 * here: another workspace's grant (which this one cannot see at all), an install
 * an owner has still to approve, and a sign-in token GitHub has revoked.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const AUTH_SECRET = 'github-granted-test-secret-at-least-32';

/**
 * Installation ids from a fresh range each run: an installation belongs to
 * exactly one workspace across the whole table, so a fixed id would collide with
 * any other test file claiming the same one and read as somebody else's.
 */
const BASE = 10_000_000 + Math.floor(Math.random() * 8_000_000);
const [ANN, ACME] = [BASE + 1, BASE + 2];

interface Installed {
   id: number;
   login: string;
   type: string;
   names: string[];
}

function githubStub(
   installed: Installed[],
   options: { status?: number } = {}
): typeof globalThis.fetch {
   return (async (input: string | URL | Request) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      if (options.status && options.status !== 200) {
         return new Response(JSON.stringify({ message: 'Bad credentials' }), {
            status: options.status,
            headers: { 'content-type': 'application/json' },
         });
      }
      if (target.pathname === '/user/installations') {
         return Response.json({
            total_count: installed.length,
            installations: installed.map((one) => ({
               id: one.id,
               account: { login: one.login, type: one.type },
            })),
         });
      }
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(target.pathname);
      if (match) {
         const one = installed.find((candidate) => candidate.id === Number(match[1]));
         if (!one) return new Response('no such installation', { status: 404 });
         return Response.json({
            total_count: one.names.length,
            repositories: one.names.map((name, index) => ({
               id: one.id * 1000 + index,
               name,
               full_name: `${one.login}/${name}`,
               private: true,
               default_branch: 'main',
               html_url: `https://github.com/${one.login}/${name}`,
            })),
         });
      }
      return new Response(`unexpected ${target.pathname}`, { status: 500 });
   }) as unknown as typeof globalThis.fetch;
}

interface GrantedBody {
   repositories: Array<{
      fullName: string;
      accountLogin: string | null;
      accountType: string | null;
      installationId: number;
      private: boolean;
      defaultBranch: string | null;
      url: string;
   }>;
   accounts: Array<{ accountLogin: string | null; accountType: string | null; repositories: number }>;
   installPending: boolean;
   refreshedAt: string | null;
   canManage: boolean;
}

describe(
   'the repositories a workspace was granted',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      /** Swapped per test: what GitHub answers for the refresh under way. */
      let answer: typeof globalThis.fetch;
      let ownerId: string;
      let memberId: string;
      let strangerId: string;
      let ownerToken: string;
      let memberToken: string;
      let strangerToken: string;
      let w1: string;
      let w2: string;
      const suffix = randomBytes(4).toString('hex');

      async function user(label: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${label})
            RETURNING id`;
         return row!.id as string;
      }

      async function workspace(label: string, owner: string): Promise<string> {
         const settings = { issuePrefix: 'GRA', defaultRole: 'member', allowMemberInvites: false };
         const [row] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
                    ${sql.json(settings as never)}, ${owner})
            RETURNING id`;
         const id = row!.id as string;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${id}, ${owner}, 'owner')`;
         return id;
      }

      async function linkGitHub(userId: string, token: string): Promise<void> {
         await sql`DELETE FROM auth_accounts WHERE user_id = ${userId}`;
         await sql`
            INSERT INTO auth_accounts (id, user_id, account_id, provider_id, access_token)
            VALUES (${randomUUID()}, ${userId}, ${`gh-${userId}`}, 'github',
                    ${await symmetricEncrypt({ key: AUTH_SECRET, data: token })})`;
      }

      function call(token: string, method: string, path: string, workspaceId = w1) {
         return app.request(`/api/v1/github/${workspaceId}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
         });
      }

      async function granted(token: string, workspaceId = w1): Promise<GrantedBody> {
         const response = await call(token, 'GET', '/granted-repositories', workspaceId);
         assert.equal(response.status, 200);
         return (await response.json()) as GrantedBody;
      }

      async function refresh(token: string, workspaceId = w1): Promise<Response> {
         return call(token, 'POST', '/granted-repositories/refresh', workspaceId);
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         ownerId = await user('gra-owner');
         memberId = await user('gra-member');
         strangerId = await user('gra-stranger');
         w1 = await workspace('gra-w1', ownerId);
         w2 = await workspace('gra-w2', strangerId);
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${w1}, ${memberId}, 'member')`;
         ownerToken = await issueTestToken(sql, ownerId);
         memberToken = await issueTestToken(sql, memberId);
         strangerToken = await issueTestToken(sql, strangerId);

         answer = githubStub([]);
         const registry = new Registry();
         registry.registerAll(
            githubMounts({
               sessions: new SessionService({
                  sql,
                  auth: null,
                  bearer: [personalTokenResolver(sql)],
               }),
               sql,
               settings: new GitHubSettingsRepository(sql),
               pullRequests: new PullRequestStore({ sql, issues: new IssueRepository(sql) }),
               githubApp: null,
               connections: null,
               userAccess: new GitHubUserAccess({
                  sql,
                  authSecret: AUTH_SECRET,
                  // Read through a holder, so a test can decide what GitHub says
                  // without rebuilding the mount.
                  fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
                     answer(...args)) as typeof globalThis.fetch,
                  apiBaseUrl: 'https://api.github.test',
               }),
            })
         );
         app = createApp(registry);
      });

      beforeEach(async () => {
         await sql`DELETE FROM github_granted_repositories WHERE workspace_id IN (${w1}, ${w2})`;
         await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1}, ${w2})`;
         await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1}, ${w2})`;
         await linkGitHub(ownerId, 'ghu_owner');
         await linkGitHub(strangerId, 'ghu_stranger');
         answer = githubStub([]);
      });

      after(async () => {
         try {
            await sql`DELETE FROM github_granted_repositories WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM auth_accounts WHERE user_id IN (${ownerId}, ${memberId}, ${strangerId})`;
            await sql`DELETE FROM personal_api_tokens WHERE user_id IN (${ownerId}, ${memberId}, ${strangerId})`;
            await sql`DELETE FROM outbox_events WHERE workspace_id IN (${w1}, ${w2})`;
            await deleteWorkspaceAgents(sql, [w1, w2]);
            await deleteWorkspaceBoards(sql, [w1, w2]);
            await sql`DELETE FROM issue_status_definitions WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM workspaces WHERE id IN (${w1}, ${w2})`;
            await sql`DELETE FROM users WHERE id IN (${ownerId}, ${memberId}, ${strangerId})`;
         } finally {
            await closeDatabase(sql);
         }
      });

      test('a refresh lists every granted repository, grouped by account', async () => {
         answer = githubStub([
            { id: ANN, login: 'ann', type: 'User', names: ['diary'] },
            { id: ACME, login: 'acme', type: 'Organization', names: ['api', 'web'] },
         ]);

         const response = await refresh(ownerToken);
         const body = (await response.json()) as GrantedBody;

         assert.equal(response.status, 200);
         assert.deepEqual(
            body.repositories.map((repository) => repository.fullName),
            ['acme/api', 'acme/web', 'ann/diary']
         );
         assert.deepEqual(
            body.accounts.map((account) => [account.accountLogin, account.accountType, account.repositories]),
            [
               ['acme', 'Organization', 2],
               ['ann', 'User', 1],
            ]
         );
         assert.equal(body.repositories[0]!.installationId, ACME);
         assert.equal(body.repositories[0]!.private, true);
         assert.equal(body.repositories[0]!.defaultBranch, 'main');
         assert.equal(body.repositories[0]!.url, 'https://github.com/acme/api');
         assert.ok(body.refreshedAt);

         // And a plain read says the same thing without asking GitHub again.
         answer = githubStub([]);
         const read = await granted(ownerToken);
         assert.equal(read.repositories.length, 3);
      });

      test('an ordinary member reads the list; only an admin refreshes it', async () => {
         answer = githubStub([{ id: ANN, login: 'ann', type: 'User', names: ['diary'] }]);
         await refresh(ownerToken);

         const read = await granted(memberToken);
         const refused = await refresh(memberToken);

         assert.equal(read.repositories.length, 1);
         assert.equal(read.canManage, false);
         assert.equal(refused.status, 403);
      });

      test('another workspace cannot see what this one was granted', async () => {
         answer = githubStub([{ id: ANN, login: 'ann', type: 'User', names: ['diary'] }]);
         await refresh(ownerToken);

         // A member of W2 asking about W2 sees their own empty list…
         const theirs = await granted(strangerToken, w2);
         // …and W1 is a workspace that, to them, does not exist.
         const foreign = await call(strangerToken, 'GET', '/granted-repositories', w1);
         const missing = await call(strangerToken, 'GET', '/granted-repositories', randomUUID());

         assert.deepEqual(theirs.repositories, []);
         assert.equal(foreign.status, 404);
         assert.equal(missing.status, 404);
      });

      test('a second refresh replaces the list rather than duplicating it', async () => {
         answer = githubStub([{ id: ANN, login: 'ann', type: 'User', names: ['diary', 'old'] }]);
         await refresh(ownerToken);

         answer = githubStub([{ id: ANN, login: 'ann', type: 'User', names: ['diary'] }]);
         const body = (await (await refresh(ownerToken)).json()) as GrantedBody;

         assert.deepEqual(
            body.repositories.map((repository) => repository.fullName),
            ['ann/diary']
         );
      });

      test('a revoked sign-in token asks them to sign in again', async () => {
         answer = githubStub([{ id: ANN, login: 'ann', type: 'User', names: ['diary'] }]);
         await refresh(ownerToken);

         answer = githubStub([], { status: 401 });
         const response = await refresh(ownerToken);
         const body = (await response.json()) as { error?: { code?: string; message?: string } };

         assert.equal(response.status, 409);
         assert.equal(body.error?.code, 'GITHUB_SIGN_IN_AGAIN');
         assert.match(body.error?.message ?? '', /sign in/i);
         // The list that was already read is still readable: a revoked token is
         // something to fix, not a reason to forget the grant.
         const read = await granted(ownerToken);
         assert.equal(read.repositories.length, 1);
      });

      test('nobody with a GitHub account linked is told that, not shown nothing', async () => {
         await sql`DELETE FROM auth_accounts WHERE user_id = ${ownerId}`;

         const response = await refresh(ownerToken);
         const body = (await response.json()) as { error?: { code?: string } };

         assert.equal(response.status, 409);
         assert.equal(body.error?.code, 'GITHUB_NOT_LINKED');
      });

      test('an install an owner has still to approve reads as pending', async () => {
         await sql`
            INSERT INTO github_install_offers (workspace_id, user_id, status)
            VALUES (${w1}, ${ownerId}, 'pending')`;

         const body = await granted(ownerToken);

         assert.equal(body.installPending, true);
         assert.deepEqual(body.repositories, []);
         // And the workspace next door is not waiting on anything.
         assert.equal((await granted(strangerToken, w2)).installPending, false);
      });

      test('the project repository picker offers the same granted list', async () => {
         answer = githubStub([{ id: ACME, login: 'acme', type: 'Organization', names: ['api'] }]);
         await refresh(ownerToken);

         const response = await call(ownerToken, 'GET', '/github-repositories');
         const body = (await response.json()) as {
            accounts: string[];
            repositories: Array<{ fullName: string; account: string; installationId: number | null }>;
         };

         assert.equal(response.status, 200);
         assert.deepEqual(body.accounts, ['acme']);
         assert.equal(body.repositories[0]!.fullName, 'acme/api');
         assert.equal(body.repositories[0]!.installationId, ACME);
      });
   }
);
