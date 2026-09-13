import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { GitHubAppRepository, type StoredApp } from '../integrations/github-app.ts';
import { OAuthStateStore } from '../integrations/oauth.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { APP_SEALING_KEY } from '../test-support/github-app.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { integrationMounts } from './integrations.ts';

/**
 * Repository access granted once, at a person's first login.
 *
 * The promise this makes is narrow enough to test: the *first* login of someone
 * whose workspace has no installation is sent to GitHub to choose an account
 * and its repositories; every login after that only identifies them. What makes
 * the second login quiet is a row, not a guess — so the interesting cases are
 * the ones where nothing was installed: the organisation install an owner still
 * has to approve, and the person who closed GitHub's tab and came back.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

/** The slug an operator would configure for an App Berry did not create. */
const CONFIGURED_SLUG = 'berry-configured-slug';

/**
 * The same repository, answering "no App is stored".
 *
 * `github_apps` holds one row for the whole deployment, so a test cannot delete
 * it to make the point without answering for every other test file that writes
 * one. Methods are bound to the real instance because they read private fields,
 * which a proxy is not the brand of.
 */
function withoutStoredApp(real: GitHubAppRepository): GitHubAppRepository {
   return new Proxy(real, {
      get(target, property, receiver) {
         if (property === 'app') return async () => null;
         const value = Reflect.get(target, property, receiver);
         return typeof value === 'function' ? value.bind(target) : value;
      },
   });
}

/**
 * The same repository, answering with the App *this file* wrote.
 *
 * `github_apps` holds one row for the whole deployment, so another test file
 * saving its own App replaces this one's — and an assertion about the install
 * URL would then be an assertion about that file's slug, which is a race this
 * file loses roughly whenever the two run together.
 *
 * The row itself still has to be there: signing the App's JWT reads the sealed
 * private key from it. What is pinned here is only what the mount is *told* the
 * stored App is, which is the App this file saved and no other.
 */
function withStoredApp(real: GitHubAppRepository, app: StoredApp): GitHubAppRepository {
   return new Proxy(real, {
      get(target, property, receiver) {
         if (property === 'app') return async () => app;
         const value = Reflect.get(target, property, receiver);
         return typeof value === 'function' ? value.bind(target) : value;
      },
   });
}

/** GitHub's answer when the App asks what an installation is. */
function githubStub(account: { login: string; type: string }): typeof globalThis.fetch {
   return (async (input: string | URL | Request) => {
      const target = new URL(typeof input === 'string' ? input : input.toString());
      if (/^\/app\/installations\/\d+$/.test(target.pathname)) {
         return new Response(JSON.stringify({ account: { login: account.login, type: account.type } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
         });
      }
      return new Response('unexpected', { status: 500 });
   }) as unknown as typeof globalThis.fetch;
}

describe(
   'granting repository access at first login',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      /** The same mount with a configured slug and no App of its own. */
      let slugOnlyApp: BerryApp;
      /** And the same again with neither, which is the state that must speak up. */
      let noSlugApp: BerryApp;
      let states: OAuthStateStore;
      let githubApp: GitHubAppRepository;
      let u1Token: string;
      let u1Id: string;
      let w1Id: string;
      let w2Id: string;

      const suffix = randomBytes(4).toString('hex');
      /** The App this file writes, and the only one it asserts about. */
      const ours = {
         appId: 4242,
         slug: `berry-${suffix}`,
         name: 'Berry Test',
         clientId: 'Iv1.test',
         htmlUrl: 'https://github.com/apps/berry-test',
      };

      /** The step the browser is told to take after a sign-in. */
      async function accessStep(): Promise<{ next: string; installUrl: string | null }> {
         const response = await app.request('/api/v1/integrations/github/app/repository-access', {
            method: 'POST',
            headers: { authorization: `Bearer ${u1Token}`, 'content-type': 'application/json' },
            body: '{}',
         });
         assert.equal(response.status, 200);
         return (await response.json()) as { next: string; installUrl: string | null };
      }

      /** What GitHub's setup redirect does when it comes back. */
      async function installationCallback(query: string): Promise<string> {
         const response = await app.request(
            `/api/v1/integrations/github/installation/callback?${query}`
         );
         assert.equal(response.status, 302);
         const location = response.headers.get('location') ?? '';
         return new URL(location).searchParams.get('status') ?? '';
      }

      function stateOf(installUrl: string): string {
         return new URL(installUrl).searchParams.get('state') ?? '';
      }

      async function offerStatus(workspaceId = w1Id): Promise<string | null> {
         const [row] = await sql<Array<{ status: string }>>`
            SELECT status FROM github_install_offers
             WHERE workspace_id = ${workspaceId} AND user_id = ${u1Id}`;
         return row?.status ?? null;
      }

      before(async () => {
         sql = openDatabase({ url: url! });

         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`install-u1-${suffix}@berry.test`}, 'Install U1')
            RETURNING id`;
         u1Id = user!.id as string;
         const settings = { issuePrefix: 'INS', defaultRole: 'member', allowMemberInvites: false };
         const [w1] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Install W1 ${suffix}`}, ${`install-w1-${suffix}`},
                    ${sql.json(settings as never)}, ${u1Id})
            RETURNING id`;
         const [w2] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Install W2 ${suffix}`}, ${`install-w2-${suffix}`},
                    ${sql.json(settings as never)}, ${u1Id})
            RETURNING id`;
         w1Id = w1!.id as string;
         w2Id = w2!.id as string;
         // U1 owns W1 and is not a member of W2, which is the workspace no
         // state of theirs may reach.
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${w1Id}, ${u1Id}, 'owner')`;
         await sql`UPDATE users SET last_workspace_id = ${w1Id} WHERE id = ${u1Id}`;
         u1Token = await issueTestToken(sql, u1Id);

         states = new OAuthStateStore({ sql });
         githubApp = new GitHubAppRepository({
            sql,
            // The shared fixture key: the App row is a deployment singleton, so a
            // row written by another test file has to be openable here too.
            sealer: sealerFromKey(APP_SEALING_KEY),
            fetch: githubStub({ login: 'berry-org', type: 'Organization' }),
            apiBaseUrl: 'https://api.github.test',
         });
         const stored = await githubApp.saveApp(
            {
               ...ours,
               clientSecret: 'shh',
               // A real key, because asking GitHub what an installation is
               // starts by signing the App's own JWT with it.
               privateKey: generateKeyPairSync('rsa', {
                  modulusLength: 2048,
                  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
                  publicKeyEncoding: { type: 'spki', format: 'pem' },
               }).privateKey,
               webhookSecret: null,
            },
            u1Id
         );
         // Read back from the row we just wrote, but only for the timestamp:
         // every field the tests assert on is this file's own input, because
         // the row may already have been replaced by another file's App.
         const ourApp: StoredApp = { ...ours, createdAt: stored.createdAt };

         const mount = (overrides: {
            githubApp: GitHubAppRepository;
            appSlug: string | null;
         }): BerryApp => {
            const registry = new Registry();
            registry.registerAll(
               integrationMounts({
                  sessions: new SessionService({
                     sql,
                     auth: null,
                     bearer: [personalTokenResolver(sql)],
                  }),
                  boards: new BoardRepository(sql),
                  connections: null,
                  states,
                  github: null,
                  githubApp: overrides.githubApp,
                  appSlug: overrides.appSlug,
                  publicUrl: 'http://localhost:4000',
                  appUrl: 'http://localhost:3000',
                  workspaceSlug: async (id: string) => {
                     const [row] = await sql`SELECT slug FROM workspaces WHERE id = ${id}`;
                     return (row?.slug as string | undefined) ?? null;
                  },
                  firstRunSetup: null,
               })
            );
            return createApp(registry);
         };
         app = mount({ githubApp: withStoredApp(githubApp, ourApp), appSlug: CONFIGURED_SLUG });
         slugOnlyApp = mount({ githubApp: withoutStoredApp(githubApp), appSlug: CONFIGURED_SLUG });
         noSlugApp = mount({ githubApp: withoutStoredApp(githubApp), appSlug: null });
      });

      beforeEach(async () => {
         await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1Id}, ${w2Id})`;
         await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1Id}, ${w2Id})`;
         await sql`DELETE FROM integration_oauth_states WHERE workspace_id IN (${w1Id}, ${w2Id})`;
      });

      after(async () => {
         // Best effort, and the connection closes either way: a teardown that
         // throws would leave the pool open and hang the file until its timeout,
         // which hides whatever the tests actually said.
         try {
            await sql`DELETE FROM github_install_offers WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM github_installations WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM integration_oauth_states WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM github_apps WHERE app_id = 4242`;
            await sql`DELETE FROM personal_api_tokens WHERE user_id = ${u1Id}`;
            // A new workspace is seeded with agents by trigger, and the
            // Orchestrator refuses deletion; the shared helper is what gets a
            // workspace out of the way.
            await sql`DELETE FROM outbox_events WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await deleteWorkspaceAgents(sql, [w1Id, w2Id]);
            await deleteWorkspaceBoards(sql, [w1Id, w2Id]);
            await sql`DELETE FROM issue_status_definitions WHERE workspace_id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM workspaces WHERE id IN (${w1Id}, ${w2Id})`;
            await sql`DELETE FROM users WHERE id = ${u1Id}`;
         } finally {
            await closeDatabase(sql);
         }
      });

      test('a first login is sent to GitHub to choose an account and its repositories', async () => {
         const step = await accessStep();

         assert.equal(step.next, 'install');
         assert.ok(step.installUrl, 'the browser is given somewhere to go');
         assert.ok(
            step.installUrl!.startsWith(`https://github.com/apps/${ours.slug}/installations/new`),
            step.installUrl!
         );
         // Carried, so the callback knows whose workspace this installation is.
         assert.notEqual(stateOf(step.installUrl!), '');
         assert.equal(await offerStatus(), 'offered');
      });

      test('a later login goes straight in, with nowhere to be sent', async () => {
         await accessStep();

         const second = await accessStep();

         assert.equal(second.next, 'offered');
         assert.equal(second.installUrl, null);
      });

      test('an installation Berry already knows of is never asked for again', async () => {
         await githubApp.saveInstallation(
            { workspaceId: w1Id, installationId: 777, accountLogin: 'berry-org', accountType: 'Organization' },
            u1Id
         );

         const step = await accessStep();

         assert.equal(step.next, 'installed');
         assert.equal(step.installUrl, null);
         // A lookup, not a guess: nothing was recorded to make this quiet.
         assert.equal(await offerStatus(), null);
      });

      test('an install an owner still has to approve is recorded as pending', async () => {
         const step = await accessStep();

         const status = await installationCallback(
            `setup_action=request&state=${encodeURIComponent(stateOf(step.installUrl!))}`
         );

         assert.equal(status, 'install_requested');
         assert.equal(await offerStatus(), 'pending');
         const after = await accessStep();
         assert.equal(after.next, 'pending');
         assert.equal(after.installUrl, null);
         // And no installation was invented to stand in for one that does not
         // exist yet.
         assert.equal(await githubApp.installation(w1Id), null);
      });

      test('the pending request is on the App resource the settings page reads', async () => {
         const step = await accessStep();
         await installationCallback(
            `setup_action=request&state=${encodeURIComponent(stateOf(step.installUrl!))}`
         );

         const response = await app.request('/api/v1/integrations/github/app', {
            headers: { authorization: `Bearer ${u1Token}` },
         });
         const body = (await response.json()) as {
            installPending: boolean;
            installation: unknown;
            app: { installUrl: string };
         };

         assert.equal(response.status, 200);
         assert.equal(body.installPending, true);
         assert.equal(body.installation, null);
         assert.ok(body.app.installUrl.includes('/installations/new'));
      });

      test('someone who skips the install still has a usable account', async () => {
         await accessStep();

         // They closed GitHub's tab. Nothing is installed, they are not sent
         // back, and the App resource still offers the same link.
         const again = await accessStep();
         const response = await app.request('/api/v1/integrations/github/app', {
            headers: { authorization: `Bearer ${u1Token}` },
         });
         const body = (await response.json()) as {
            installPending: boolean;
            installation: unknown;
            app: { installUrl: string };
         };

         assert.equal(again.next, 'offered');
         assert.equal(again.installUrl, null);
         assert.equal(body.installation, null);
         assert.equal(body.installPending, false);
         assert.ok(body.app.installUrl.includes('/installations/new'));
      });

      test('a completed install is recorded against the workspace and closes the offer', async () => {
         const step = await accessStep();
         const state = stateOf(step.installUrl!);

         const status = await installationCallback(
            `installation_id=901&setup_action=install&state=${encodeURIComponent(state)}`
         );

         assert.equal(status, 'installed');
         const installation = await githubApp.installation(w1Id);
         assert.equal(installation?.installationId, 901);
         assert.equal(installation?.accountLogin, 'berry-org');
         // The offer was what they were waiting on; it goes with the answer.
         assert.equal(await offerStatus(), null);
         assert.equal((await accessStep()).next, 'installed');
      });

      test('the browser lands on a settings page that exists', async () => {
         const state = await states.start({
            workspaceId: w1Id,
            userId: u1Id,
            provider: 'github_install',
            redirectUri: 'https://github.com/apps/berry/installations/new',
            scopes: [],
         });
         const response = await app.request(
            `/api/v1/integrations/github/installation/callback?installation_id=4242&state=${encodeURIComponent(state.state)}`
         );
         const location = new URL(response.headers.get('location') ?? '');
         const [slug] = await sql`SELECT slug FROM workspaces WHERE id = ${w1Id}`;
         assert.equal(location.pathname, `/${slug!.slug as string}/settings/integrations`);
      });

      test('the state cannot be replayed', async () => {
         const step = await accessStep();
         const state = stateOf(step.installUrl!);
         await installationCallback(
            `installation_id=901&setup_action=install&state=${encodeURIComponent(state)}`
         );

         const replayed = await installationCallback(
            `installation_id=902&setup_action=install&state=${encodeURIComponent(state)}`
         );

         assert.equal(replayed, 'invalid_state');
         // The second id was never believed, so the workspace still mints
         // tokens against the installation it actually chose.
         assert.equal((await githubApp.installation(w1Id))?.installationId, 901);
      });

      test('a state cannot carry a user into a workspace they are not a member of', async () => {
         // As if the row had been written for another workspace: the callback
         // trusts the row, so the row alone must not be enough.
         const forged = await states.start({
            workspaceId: w2Id,
            userId: u1Id,
            provider: 'github_install',
            redirectUri: 'https://github.com/apps/berry/installations/new',
            scopes: [],
         });

         const status = await installationCallback(
            `installation_id=903&setup_action=install&state=${encodeURIComponent(forged.state)}`
         );

         assert.equal(status, 'install_not_permitted');
         assert.equal(await githubApp.installation(w2Id), null);
      });

      test("the stored App's slug is preferred over the configured one", async () => {
         const step = await accessStep();

         // Both are available here, and the stored App wins. Its slug is the
         // one this file saved — not whatever `github_apps`, a deployment
         // singleton another file may have written since, holds now.
         assert.ok(
            step.installUrl!.startsWith(`https://github.com/apps/${ours.slug}/installations/new`),
            step.installUrl!
         );
         assert.ok(!step.installUrl!.includes(CONFIGURED_SLUG));
      });

      test('a deployment with no App of its own offers the configured slug', async () => {
         const response = await slugOnlyApp.request(
            '/api/v1/integrations/github/app/repository-access',
            {
               method: 'POST',
               headers: { authorization: `Bearer ${u1Token}`, 'content-type': 'application/json' },
               body: '{}',
            }
         );
         const body = (await response.json()) as {
            next: string;
            installUrl: string | null;
            reason: string | null;
         };

         assert.equal(response.status, 200);
         assert.equal(body.next, 'install');
         assert.ok(
            body.installUrl!.startsWith(
               `https://github.com/apps/${CONFIGURED_SLUG}/installations/new`
            ),
            body.installUrl!
         );
         // And the offer is recorded, so this login is the only one that detours.
         assert.equal(await offerStatus(), 'offered');
      });

      test('no App and no slug skips the install and says which setting is missing', async () => {
         const response = await noSlugApp.request(
            '/api/v1/integrations/github/app/repository-access',
            {
               method: 'POST',
               headers: { authorization: `Bearer ${u1Token}`, 'content-type': 'application/json' },
               body: '{}',
            }
         );
         const body = (await response.json()) as {
            next: string;
            installUrl: string | null;
            reason: string | null;
         };

         // A usable account either way: nothing here is an error.
         assert.equal(response.status, 200);
         assert.equal(body.next, 'no_slug');
         assert.equal(body.installUrl, null);
         assert.match(body.reason ?? '', /BERRY_GITHUB_APP_SLUG/);
         // Nobody was sent anywhere, so nobody has been asked.
         assert.equal(await offerStatus(), null);
      });

      test('the App resource carries the install link and the reason there is none', async () => {
         const withSlug = (await (
            await slugOnlyApp.request('/api/v1/integrations/github/app', {
               headers: { authorization: `Bearer ${u1Token}` },
            })
         ).json()) as { installUrl: string | null; installReason: string | null };
         const without = (await (
            await noSlugApp.request('/api/v1/integrations/github/app', {
               headers: { authorization: `Bearer ${u1Token}` },
            })
         ).json()) as { installUrl: string | null; installReason: string | null };

         assert.ok(withSlug.installUrl?.includes(CONFIGURED_SLUG), String(withSlug.installUrl));
         assert.equal(withSlug.installReason, null);
         assert.equal(without.installUrl, null);
         assert.match(without.installReason ?? '', /BERRY_GITHUB_APP_SLUG/);
      });
   }
);
