import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { IssueRepository } from '../core/issues.ts';
import { GitHubAppRepository } from '../integrations/github-app.ts';
import { GitHubClient } from '../integrations/github.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { GitHubSettingsRepository } from '../scm/github-settings.ts';
import { PullRequestStore } from '../scm/pull-requests.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { APP_SEALING_KEY } from '../test-support/github-app.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { GitHubEvents } from '../scm/github-events.ts';
import { githubMounts } from './github.ts';

/**
 * A workspace reaching repositories in several accounts at once.
 *
 * One installation per workspace made a personal account and an organisation
 * mutually exclusive, and the second install silently replaced the first. What
 * replaces that is one row per account, and four things follow from it that are
 * worth pinning down: the picker lists every account's repositories and says
 * which account each came from, a token is minted against the installation that
 * owns the repository rather than whichever one was found first, disconnecting
 * one account leaves the others alone, and an installation still belongs to
 * exactly one workspace.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

/** Two accounts, each with its own repositories and its own minted token. */
const ACCOUNTS = new Map([
   [
      501,
      {
         login: 'ann',
         type: 'User',
         token: 'ghs_ann',
         repositories: [{ name: 'diary', id: 1001 }],
      },
   ],
   [
      502,
      {
         login: 'acme',
         type: 'Organization',
         token: 'ghs_acme',
         repositories: [
            { name: 'api', id: 1002 },
            { name: 'web', id: 1003 },
         ],
      },
   ],
]);

/** GitHub, as far as this test is concerned: installations, mints and listings. */
function githubStub(): { fetch: typeof globalThis.fetch; listedWith: string[] } {
   const listedWith: string[] = [];
   const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(target.pathname);
      if (mint) {
         const account = ACCOUNTS.get(Number(mint[1]));
         if (!account) return new Response('no such installation', { status: 404 });
         return Response.json(
            {
               token: account.token,
               expires_at: new Date(Date.now() + 3_600_000).toISOString(),
               permissions: { contents: 'write', metadata: 'read' },
            },
            { status: 201 }
         );
      }
      const describe_ = /^\/app\/installations\/(\d+)$/.exec(target.pathname);
      if (describe_) {
         const account = ACCOUNTS.get(Number(describe_[1]));
         if (!account) return new Response('no such installation', { status: 404 });
         return Response.json({
            account: { login: account.login, type: account.type },
            permissions: { contents: 'write' },
         });
      }
      if (target.pathname === '/installation/repositories') {
         // Which account answers is decided by the token, which is the whole
         // point: a listing that ignored it would merge one account twice.
         const presented = String(
            (init?.headers as Record<string, string> | undefined)?.authorization ?? ''
         ).replace(/^Bearer /, '');
         listedWith.push(presented);
         const account = [...ACCOUNTS.values()].find((candidate) => candidate.token === presented);
         if (!account) return new Response('unauthorised', { status: 401 });
         return Response.json({
            total_count: account.repositories.length,
            repositories: account.repositories.map((repository) => ({
               id: repository.id,
               name: repository.name,
               full_name: `${account.login}/${repository.name}`,
               private: true,
               default_branch: 'main',
               owner: { login: account.login },
               html_url: `https://github.com/${account.login}/${repository.name}`,
            })),
         });
      }
      return new Response(`unexpected ${target.pathname}`, { status: 500 });
   }) as unknown as typeof globalThis.fetch;
   return { fetch, listedWith };
}

/** A real key, because asking GitHub anything starts by signing the App's JWT. */
const APP_KEY = generateKeyPairSync('rsa', {
   modulusLength: 2048,
   privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
   publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

describe(
   'a workspace with installations on several accounts',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      let githubApp: GitHubAppRepository;
      let stub: ReturnType<typeof githubStub>;
      /**
       * Whatever App row is in the database, this test can open it.
       *
       * `github_apps` holds one row for the whole deployment, so two test files
       * that create an App share it — and a random sealing key per file would
       * have each unable to open the other's private key. A fixed key is what
       * makes the singleton survive being written by either of them.
       */
      const sealer = sealerFromKey(APP_SEALING_KEY);
      let ownerToken: string;
      let strangerToken: string;
      let ownerId: string;
      let strangerId: string;
      let w1: string;
      let w2: string;
      const suffix = randomBytes(4).toString('hex');

      function storedApp() {
         return {
            appId: 4182,
            slug: `berry-acc-${suffix}`,
            name: 'Berry Accounts',
            clientId: 'Iv1.acc',
            clientSecret: 'shh',
            privateKey: APP_KEY,
            webhookSecret: null,
            htmlUrl: null,
         };
      }

      async function user(label: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`${label}-${suffix}@berry.test`}, ${label})
            RETURNING id`;
         return row!.id as string;
      }

      async function workspace(label: string, owner: string): Promise<string> {
         const settings = { issuePrefix: 'ACC', defaultRole: 'member', allowMemberInvites: false };
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

      function call(
         token: string,
         method: string,
         path: string,
         workspaceId = w1
      ): Promise<Response> {
         return Promise.resolve(
            app.request(`/api/v1/github/${workspaceId}${path}`, {
               method,
               headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            })
         );
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         ownerId = await user('acc-owner');
         strangerId = await user('acc-stranger');
         w1 = await workspace('acc-w1', ownerId);
         w2 = await workspace('acc-w2', strangerId);
         ownerToken = await issueTestToken(sql, ownerId);
         strangerToken = await issueTestToken(sql, strangerId);

         stub = githubStub();
         githubApp = new GitHubAppRepository({
            sql,
            sealer,
            fetch: stub.fetch,
            apiBaseUrl: 'https://api.github.test',
         });
         await githubApp.saveApp(storedApp(), ownerId);

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
               githubApp,
               connections: null,
               // The same stub the App mints against, so a listing is answered
               // by the account whose token was presented.
               client: (token) =>
                  new GitHubClient({
                     token,
                     baseUrl: 'https://api.github.test',
                     fetch: stub.fetch,
                  }),
            })
         );
         app = createApp(registry);
      });

      beforeEach(async () => {
         // The App is a deployment singleton, and a mint starts by signing with
         // the key on that row — so a row has to be there. Written only when
         // there is none, because another file's fixture owns the identity of
         // the row it wrote and replacing it would break its assertions; the
         // shared fixture sealing key is what makes either row usable here.
         if (!(await githubApp.app())) await githubApp.saveApp(storedApp(), ownerId);
         await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1}, ${w2})`;
         await sql`DELETE FROM workspace_repositories WHERE workspace_id IN (${w1}, ${w2})`;
         stub.listedWith.length = 0;
         await githubApp.saveInstallation(
            { workspaceId: w1, installationId: 501, accountLogin: 'ann', accountType: 'User' },
            ownerId
         );
         await githubApp.saveInstallation(
            {
               workspaceId: w1,
               installationId: 502,
               accountLogin: 'acme',
               accountType: 'Organization',
            },
            ownerId
         );
      });

      after(async () => {
         try {
            await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM workspace_repositories WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM github_workspace_settings WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM github_apps WHERE app_id = 4182`;
            await sql`DELETE FROM personal_api_tokens WHERE user_id IN (${ownerId}, ${strangerId})`;
            await sql`DELETE FROM outbox_events WHERE workspace_id IN (${w1}, ${w2})`;
            await deleteWorkspaceAgents(sql, [w1, w2]);
            await sql`DELETE FROM issue_status_definitions WHERE workspace_id IN (${w1}, ${w2})`;
            // A new workspace comes with a default board by trigger, and a
            // board holds the workspace down by foreign key.
            await deleteWorkspaceBoards(sql, [w1, w2]);
            await sql`DELETE FROM workspace_memberships WHERE workspace_id IN (${w1}, ${w2})`;
            await sql`DELETE FROM workspaces WHERE id IN (${w1}, ${w2})`;
            await sql`DELETE FROM users WHERE id IN (${ownerId}, ${strangerId})`;
         } finally {
            await closeDatabase(sql);
         }
      });

      test('both installations are kept, rather than the second replacing the first', async () => {
         const installations = await githubApp.installations(w1);

         assert.deepEqual(
            installations.map((row) => [row.installationId, row.accountLogin]),
            [
               [501, 'ann'],
               [502, 'acme'],
            ]
         );
      });

      test('a token is minted against the installation that owns the repository', async () => {
         assert.equal((await githubApp.access(w1, 'ann')).token, 'ghs_ann');
         assert.equal((await githubApp.access(w1, 'acme')).token, 'ghs_acme');
         // An owner no account here covers is not quietly served another
         // account's token: that would be a token for repositories the caller
         // was never granted.
         await assert.rejects(githubApp.access(w1, 'someone-else'));
      });

      test('the picker merges every account and says where each repository came from', async () => {
         const response = await call(ownerToken, 'GET', '/github-repositories');
         const body = (await response.json()) as {
            accounts: string[];
            repositories: Array<{ fullName: string; owner: string; installationId: number | null }>;
         };

         assert.equal(response.status, 200);
         assert.deepEqual(body.accounts, ['acme', 'ann']);
         assert.deepEqual(
            body.repositories
               .map((row) => [row.fullName, row.installationId])
               .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
            [
               ['acme/api', 502],
               ['acme/web', 502],
               ['ann/diary', 501],
            ]
         );
         // Each account was listed with its own token, exactly once.
         assert.deepEqual([...stub.listedWith].sort(), ['ghs_acme', 'ghs_ann']);
      });

      test('searching crosses every account; filtering by one narrows to it', async () => {
         const searched = (await (
            await call(ownerToken, 'GET', '/github-repositories?q=i')
         ).json()) as { repositories: Array<{ fullName: string }> };
         const narrowed = (await (
            await call(ownerToken, 'GET', '/github-repositories?account=ann')
         ).json()) as { repositories: Array<{ fullName: string }> };

         assert.deepEqual(
            searched.repositories.map((row) => row.fullName).sort(),
            ['acme/api', 'ann/diary'],
            'a search reaches both accounts'
         );
         assert.deepEqual(
            narrowed.repositories.map((row) => row.fullName),
            ['ann/diary']
         );
      });

      test('the connected accounts are listed with their type and repository count', async () => {
         const response = await call(ownerToken, 'GET', '/accounts');
         const body = (await response.json()) as {
            accounts: Array<{
               installationId: number;
               accountLogin: string;
               accountType: string;
               repositoryCount: number | null;
               listedHere: number;
            }>;
            installPending: boolean;
         };

         assert.equal(response.status, 200);
         assert.equal(body.installPending, false);
         assert.deepEqual(
            body.accounts.map((row) => [
               row.installationId,
               row.accountLogin,
               row.accountType,
               row.repositoryCount,
            ]),
            [
               [501, 'ann', 'User', 1],
               [502, 'acme', 'Organization', 2],
            ]
         );
      });

      test('an account says how many of this workspace’s repositories it would lose', async () => {
         await sql`
            INSERT INTO workspace_repositories (id, workspace_id, url, description, position, created_by)
            VALUES (${randomUUID()}, ${w1}, 'https://github.com/acme/api', '', 1, ${ownerId}),
                   (${randomUUID()}, ${w1}, 'https://github.com/acme/web', '', 2, ${ownerId}),
                   (${randomUUID()}, ${w1}, 'https://github.com/ann/diary', '', 3, ${ownerId})`;

         const body = (await (await call(ownerToken, 'GET', '/accounts')).json()) as {
            accounts: Array<{ accountLogin: string; listedHere: number }>;
         };

         assert.deepEqual(
            body.accounts.map((row) => [row.accountLogin, row.listedHere]),
            [
               ['ann', 1],
               ['acme', 2],
            ]
         );
      });

      test('disconnecting one account leaves the other connected', async () => {
         const removed = await call(ownerToken, 'DELETE', '/accounts/501');

         assert.equal(removed.status, 204);
         assert.deepEqual(
            (await githubApp.installations(w1)).map((row) => row.installationId),
            [502]
         );
         // And the account that stayed still mints its own token.
         assert.equal((await githubApp.access(w1, 'acme')).token, 'ghs_acme');
         // Twice is a 404, not a second removal.
         assert.equal((await call(ownerToken, 'DELETE', '/accounts/501')).status, 404);
      });

      test('an installation belongs to one workspace: another cannot see or use it', async () => {
         // W2's own member asking for W1's accounts gets the 404 of a
         // workspace that is not theirs.
         assert.equal((await call(strangerToken, 'GET', '/accounts', w1)).status, 404);
         assert.equal((await call(strangerToken, 'DELETE', '/accounts/501', w1)).status, 404);

         // W2 has no installation of its own, so nothing of W1's answers for it.
         assert.deepEqual(await githubApp.installations(w2), []);
         assert.equal((await call(strangerToken, 'GET', '/accounts', w2)).status, 200);
         const body = (await (await call(strangerToken, 'GET', '/accounts', w2)).json()) as {
            accounts: unknown[];
         };
         assert.deepEqual(body.accounts, []);

         // The database refuses the claim outright, wherever it is written from.
         await assert.rejects(
            githubApp.saveInstallation(
               { workspaceId: w2, installationId: 501, accountLogin: 'ann', accountType: 'User' },
               strangerId
            )
         );
         assert.equal((await githubApp.installations(w1)).length, 2);
      });

      test('a webhook is routed by its installation id, not by the account name', async () => {
         // W2 gets an installation of its own, so there are three in play and
         // two of them belong to W1. A payload carries exactly one id, and that
         // id is the whole of what decides whose rows are written.
         await githubApp.saveInstallation(
            {
               workspaceId: w2,
               installationId: 503,
               accountLogin: 'other',
               accountType: 'Organization',
            },
            strangerId
         );
         const applied: Array<{ workspaceId: string; repoFullName: string }> = [];
         const events = new GitHubEvents({
            workspaceForInstallation: (installationId) => githubApp.claimedBy(installationId),
            settings: new GitHubSettingsRepository(sql),
            pullRequests: {
               upsertPullRequest: async (workspaceId, pr) => {
                  applied.push({ workspaceId, repoFullName: pr.repoFullName });
                  return { id: randomUUID(), stale: false };
               },
               linkIssues: async () => [],
               closeLinkedIssues: async () => [],
               upsertCheck: async () => [],
               publishUpdated: async () => {},
            },
            removeInstallation: (installationId) => githubApp.removeInstallationById(installationId),
            publishConnection: async () => {},
         });

         for (const [installationId, fullName] of [
            [501, 'ann/diary'],
            [502, 'acme/api'],
            [503, 'other/thing'],
            [999, 'nobody/repo'],
         ] as Array<[number, string]>) {
            await events.apply('pull_request', {
               action: 'opened',
               installation: { id: installationId },
               repository: { id: installationId, full_name: fullName },
               pull_request: {
                  id: installationId * 10,
                  number: 1,
                  title: 'a change',
                  html_url: `https://github.com/${fullName}/pull/1`,
                  state: 'open',
                  draft: false,
                  merged: false,
                  merged_at: null,
                  closed_at: null,
                  updated_at: '2026-09-11T10:00:00Z',
                  body: null,
                  head: { ref: 'topic', sha: 'abc123' },
                  user: { login: 'octo' },
               },
            });
         }

         assert.deepEqual(applied, [
            { workspaceId: w1, repoFullName: 'ann/diary' },
            { workspaceId: w1, repoFullName: 'acme/api' },
            { workspaceId: w2, repoFullName: 'other/thing' },
         ]);
      });

      test('an uninstall on GitHub forgets one account and leaves the workspace’s others', async () => {
         const events = new GitHubEvents({
            workspaceForInstallation: (installationId) => githubApp.claimedBy(installationId),
            settings: new GitHubSettingsRepository(sql),
            pullRequests: {
               upsertPullRequest: async () => ({ id: randomUUID(), stale: false }),
               linkIssues: async () => [],
               closeLinkedIssues: async () => [],
               upsertCheck: async () => [],
               publishUpdated: async () => {},
            },
            removeInstallation: (installationId) => githubApp.removeInstallationById(installationId),
            publishConnection: async () => {},
         });

         const result = await events.apply('installation', {
            action: 'deleted',
            installation: { id: 501 },
         });

         assert.equal(result.applied, true);
         assert.deepEqual(
            (await githubApp.installations(w1)).map((row) => row.installationId),
            [502]
         );
      });

      test('a member who is not an admin cannot read or change the accounts', async () => {
         const memberId = await user(`acc-member-${randomBytes(2).toString('hex')}`);
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${w1}, ${memberId}, 'member')`;
         const memberToken = await issueTestToken(sql, memberId);

         assert.equal((await call(memberToken, 'GET', '/accounts')).status, 403);
         assert.equal((await call(memberToken, 'DELETE', '/accounts/501')).status, 403);
         assert.equal((await githubApp.installations(w1)).length, 2);

         await sql`DELETE FROM personal_api_tokens WHERE user_id = ${memberId}`;
         await sql`DELETE FROM workspace_memberships WHERE user_id = ${memberId}`;
         await sql`DELETE FROM users WHERE id = ${memberId}`;
      });
   }
);
