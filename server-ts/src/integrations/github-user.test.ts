import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { symmetricEncrypt } from 'better-auth/crypto';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { GitHubUserAccess, GitHubUserUnavailable } from './github-user.ts';

/**
 * What a person granted Berry on GitHub, read with their own token.
 *
 * Berry has no App private key here, so it cannot mint an installation token and
 * `/installation/repositories` is closed to it. The user-to-server token from
 * sign-in is what it does have, and these two endpoints are what that token can
 * answer: where the person installed the App, and which repositories they chose
 * there. Everything below is about the recording of those answers — against the
 * right workspace, replacing rather than accumulating, and saying "sign in
 * again" rather than "no repositories" when the token has been revoked.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const AUTH_SECRET = 'github-user-test-secret-at-least-32-chars';

interface Installed {
   id: number;
   login: string;
   type: string;
   repositories: Array<{
      id: number;
      full_name: string;
      private?: boolean;
      default_branch?: string;
      html_url?: string;
   }>;
}

/**
 * GitHub answering as it does for a user-to-server token.
 *
 * `calls` records the paths asked for, so a test can say that a second
 * installation was read as well as the first — the bug that would otherwise
 * look like an organisation granting nothing.
 */
function githubStub(
   installed: Installed[],
   options: { status?: number; calls?: string[] } = {}
): typeof globalThis.fetch {
   return (async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      options.calls?.push(target.pathname);
      // A revoked token is refused on every path, which is what makes it a
      // different answer from "you were granted nothing".
      if (options.status && options.status !== 200) {
         assert.equal((init?.headers as Record<string, string>)?.authorization, 'Bearer ghu_live');
         return new Response(JSON.stringify({ message: 'Bad credentials' }), {
            status: options.status,
            headers: { 'content-type': 'application/json' },
         });
      }
      if (target.pathname === '/user/installations') {
         return new Response(
            JSON.stringify({
               total_count: installed.length,
               installations: installed.map((one) => ({
                  id: one.id,
                  account: { login: one.login, type: one.type },
               })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
         );
      }
      const match = /^\/user\/installations\/(\d+)\/repositories$/.exec(target.pathname);
      if (match) {
         const one = installed.find((candidate) => candidate.id === Number(match[1]));
         if (!one) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
         return new Response(
            JSON.stringify({ total_count: one.repositories.length, repositories: one.repositories }),
            { status: 200, headers: { 'content-type': 'application/json' } }
         );
      }
      return new Response('unexpected', { status: 500 });
   }) as unknown as typeof globalThis.fetch;
}

describe(
   'reading what GitHub granted with the signed-in person’s own token',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let u1Id: string;
      let u2Id: string;
      let w1Id: string;
      let w2Id: string;

      const suffix = randomBytes(4).toString('hex');

      function access(stub: typeof globalThis.fetch): GitHubUserAccess {
         return new GitHubUserAccess({
            sql,
            authSecret: AUTH_SECRET,
            fetch: stub,
            apiBaseUrl: 'https://api.github.test',
         });
      }

      /** The sealed token Better Auth would have stored at sign-in. */
      async function linkGitHub(userId: string, token: string | null): Promise<void> {
         await sql`DELETE FROM auth_accounts WHERE user_id = ${userId}`;
         if (token === null) return;
         await sql`
            INSERT INTO auth_accounts (id, user_id, account_id, provider_id, access_token)
            VALUES (${randomUUID()}, ${userId}, ${`gh-${userId}`}, 'github',
                    ${await symmetricEncrypt({ key: AUTH_SECRET, data: token })})`;
      }

      async function grantedNames(workspaceId: string): Promise<string[]> {
         const rows = await sql<Array<{ full_name: string }>>`
            SELECT full_name FROM github_granted_repositories
             WHERE workspace_id = ${workspaceId} ORDER BY full_name`;
         return rows.map((row) => row.full_name);
      }

      before(async () => {
         sql = openDatabase({ url: url! });
         const settings = { issuePrefix: 'GHU', defaultRole: 'member', allowMemberInvites: false };
         const [u1] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`ghuser-u1-${suffix}@berry.test`}, 'GH U1') RETURNING id`;
         const [u2] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`ghuser-u2-${suffix}@berry.test`}, 'GH U2') RETURNING id`;
         u1Id = u1!.id as string;
         u2Id = u2!.id as string;
         const [w1] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`GHU W1 ${suffix}`}, ${`ghu-w1-${suffix}`},
                    ${sql.json(settings as never)}, ${u1Id}) RETURNING id`;
         const [w2] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`GHU W2 ${suffix}`}, ${`ghu-w2-${suffix}`},
                    ${sql.json(settings as never)}, ${u2Id}) RETURNING id`;
         w1Id = w1!.id as string;
         w2Id = w2!.id as string;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${w1Id}, ${u1Id}, 'owner'), (${w2Id}, ${u2Id}, 'owner')`;
      });

      beforeEach(async () => {
         await sql`DELETE FROM github_granted_repositories WHERE workspace_id IN (${w1Id}, ${w2Id})`;
         await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1Id}, ${w2Id})`;
         await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1Id}, ${w2Id})`;
         await linkGitHub(u1Id, 'ghu_live');
         await linkGitHub(u2Id, 'ghu_live_two');
      });

      after(async () => {
         try {
            await sql`DELETE FROM github_granted_repositories WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM auth_accounts WHERE user_id IN (${u1Id}, ${u2Id})`;
            await sql`DELETE FROM outbox_events WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await deleteWorkspaceAgents(sql, [w1Id, w2Id]);
            await deleteWorkspaceBoards(sql, [w1Id, w2Id]);
            await sql`DELETE FROM issue_status_definitions WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM workspaces WHERE id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM users WHERE id IN (${u1Id}, ${u2Id})`;
         } finally {
            await closeDatabase(sql);
         }
      });

      test('every account the person installed on is recorded, with its repositories', async () => {
         const calls: string[] = [];
         const result = await access(
            githubStub(
               [
                  {
                     id: 11,
                     login: 'alice',
                     type: 'User',
                     repositories: [
                        {
                           id: 101,
                           full_name: 'alice/notes',
                           private: true,
                           default_branch: 'main',
                           html_url: 'https://github.com/alice/notes',
                        },
                     ],
                  },
                  {
                     id: 12,
                     login: 'acme',
                     type: 'Organization',
                     repositories: [
                        { id: 201, full_name: 'acme/api', default_branch: 'trunk' },
                        { id: 202, full_name: 'acme/web' },
                     ],
                  },
               ],
               { calls }
            )
         ).refresh({ workspaceId: w1Id, userId: u1Id });

         assert.deepEqual(
            result.installations.map((one) => [one.installationId, one.accountLogin, one.accountType]),
            [
               [11, 'alice', 'User'],
               [12, 'acme', 'Organization'],
            ]
         );
         // Both accounts were asked: an organisation's repositories missing is
         // what a single-installation read looks like from the outside.
         assert.ok(calls.includes('/user/installations/11/repositories'));
         assert.ok(calls.includes('/user/installations/12/repositories'));
         assert.deepEqual(await grantedNames(w1Id), ['acme/api', 'acme/web', 'alice/notes']);

         const rows = await sql<
            Array<{
               repository_id: string;
               installation_id: string;
               private: boolean;
               default_branch: string | null;
               account_type: string | null;
               refreshed_at: Date;
            }>
         >`SELECT repository_id, installation_id, private, default_branch, account_type, refreshed_at
             FROM github_granted_repositories
            WHERE workspace_id = ${w1Id} AND full_name = 'alice/notes'`;
         assert.equal(Number(rows[0]!.repository_id), 101);
         assert.equal(Number(rows[0]!.installation_id), 11);
         assert.equal(rows[0]!.private, true);
         assert.equal(rows[0]!.default_branch, 'main');
         assert.equal(rows[0]!.account_type, 'User');
         // When GitHub said so, which is the only honest thing a cache of
         // somebody else's truth can offer a reader.
         assert.ok(Date.now() - new Date(rows[0]!.refreshed_at).getTime() < 60_000);

         // And the installations are the ones the rest of the integration reads.
         const installations = await sql`
            SELECT installation_id, account_login, installed_by FROM github_installations
             WHERE workspace_id = ${w1Id} ORDER BY installation_id`;
         assert.equal(installations.length, 2);
         assert.equal(installations[0]!.installed_by, u1Id);
      });

      test('a repository belongs to one workspace, and the other cannot see it', async () => {
         const repositories = [{ id: 101, full_name: 'alice/notes' }];
         await access(
            githubStub([{ id: 11, login: 'alice', type: 'User', repositories }])
         ).refresh({ workspaceId: w1Id, userId: u1Id });
         // The same repository granted to another workspace through another
         // account: two rows, and neither workspace reads the other's.
         await access(
            githubStub([{ id: 22, login: 'alice', type: 'User', repositories }])
         ).refresh({ workspaceId: w2Id, userId: u2Id });

         assert.deepEqual(await grantedNames(w1Id), ['alice/notes']);
         assert.deepEqual(await grantedNames(w2Id), ['alice/notes']);
         const [w1Row] = await sql<Array<{ installation_id: string }>>`
            SELECT installation_id FROM github_granted_repositories
             WHERE workspace_id = ${w1Id}`;
         assert.equal(Number(w1Row!.installation_id), 11);
         assert.deepEqual(await access(githubStub([])).granted(w2Id).then((rows) =>
            rows.map((row) => row.installationId)
         ), [22]);
      });

      test('a refresh replaces the list rather than adding to it', async () => {
         const first = access(
            githubStub([
               {
                  id: 11,
                  login: 'alice',
                  type: 'User',
                  repositories: [
                     { id: 101, full_name: 'alice/notes' },
                     { id: 102, full_name: 'alice/gone' },
                  ],
               },
            ])
         );
         await first.refresh({ workspaceId: w1Id, userId: u1Id });

         // They narrowed the grant on GitHub to one repository.
         const second = access(
            githubStub([
               {
                  id: 11,
                  login: 'alice',
                  type: 'User',
                  repositories: [{ id: 101, full_name: 'alice/notes', default_branch: 'main' }],
               },
            ])
         );
         const result = await second.refresh({ workspaceId: w1Id, userId: u1Id });

         assert.deepEqual(await grantedNames(w1Id), ['alice/notes']);
         assert.equal(result.repositories.length, 1);
         assert.equal(result.repositories[0]!.defaultBranch, 'main');
      });

      test('a revoked token reads as sign in again, not as no repositories', async () => {
         await access(
            githubStub([
               { id: 11, login: 'alice', type: 'User', repositories: [{ id: 101, full_name: 'alice/notes' }] },
            ])
         ).refresh({ workspaceId: w1Id, userId: u1Id });

         await assert.rejects(
            () => access(githubStub([], { status: 401 })).refresh({ workspaceId: w1Id, userId: u1Id }),
            (error: unknown) =>
               error instanceof GitHubUserUnavailable && error.reason === 'sign_in_again'
         );

         // The stale token is gone, so nothing retries with a credential GitHub
         // has already refused.
         const [row] = await sql<Array<{ access_token: string | null }>>`
            SELECT access_token FROM auth_accounts WHERE user_id = ${u1Id}`;
         assert.equal(row!.access_token, null);
         // And what GitHub said last time is still there to read: a revoked
         // token is a thing to fix, not a reason to forget the grant.
         assert.deepEqual(await grantedNames(w1Id), ['alice/notes']);
      });

      test('nobody signed in with GitHub is a different answer again', async () => {
         await linkGitHub(u1Id, null);

         await assert.rejects(
            () => access(githubStub([])).refresh({ workspaceId: w1Id, userId: u1Id }),
            (error: unknown) => error instanceof GitHubUserUnavailable && error.reason === 'not_linked'
         );
      });

      test('an installation another workspace already holds is never taken from it', async () => {
         await access(
            githubStub([
               { id: 11, login: 'alice', type: 'User', repositories: [{ id: 101, full_name: 'alice/notes' }] },
            ])
         ).refresh({ workspaceId: w1Id, userId: u1Id });

         // U2's GitHub account can see the same installation. It belongs to W1.
         const result = await access(
            githubStub([
               { id: 11, login: 'alice', type: 'User', repositories: [{ id: 101, full_name: 'alice/notes' }] },
            ])
         ).refresh({ workspaceId: w2Id, userId: u2Id });

         assert.deepEqual(
            result.installations.map((one) => [one.installationId, one.claimedElsewhere]),
            [[11, true]]
         );
         assert.deepEqual(await grantedNames(w2Id), []);
         assert.deepEqual(await grantedNames(w1Id), ['alice/notes']);
         const rows = await sql`
            SELECT workspace_id FROM github_installations WHERE installation_id = 11`;
         assert.equal(rows.length, 1);
         assert.equal(rows[0]!.workspace_id, w1Id);
      });

      test('a grant closes the outstanding offer, so nobody is asked twice', async () => {
         await sql`
            INSERT INTO github_install_offers (workspace_id, user_id, status)
            VALUES (${w1Id}, ${u1Id}, 'pending')`;

         await access(
            githubStub([
               { id: 11, login: 'alice', type: 'User', repositories: [{ id: 101, full_name: 'alice/notes' }] },
            ])
         ).refresh({ workspaceId: w1Id, userId: u1Id });

         const offers = await sql`
            SELECT status FROM github_install_offers WHERE workspace_id = ${w1Id}`;
         assert.equal(offers.length, 0);
      });

      test('nothing installed yet leaves the list empty and says so plainly', async () => {
         const result = await access(githubStub([])).refresh({ workspaceId: w1Id, userId: u1Id });

         assert.deepEqual(result.installations, []);
         assert.deepEqual(result.repositories, []);
         assert.deepEqual(await grantedNames(w1Id), []);
      });
   }
);
