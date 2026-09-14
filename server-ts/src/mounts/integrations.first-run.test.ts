import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { FirstRunSetup } from '../auth/first-run-setup.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { GitHubAppRepository } from '../integrations/github-app.ts';
import { OAuthStateStore } from '../integrations/oauth.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { integrationMounts } from './integrations.ts';

/**
 * Creating the GitHub App on a deployment nobody can sign into yet.
 *
 * The manifest route needs a session, and the session needs the App the route
 * creates. The setup token is the way out, and it has to be narrow: good while
 * there is no App and no user, good once, and never a thing an API response
 * hands back to whoever asks.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   'first-run App setup through the manifest route',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;

      /** The mount, with the world it believes in fixed by the test. */
      function appWith(state: { app: boolean; user: boolean }): {
         app: BerryApp;
         setup: FirstRunSetup;
      } {
         const setup = new FirstRunSetup({
            world: { hasApp: async () => state.app, hasUser: async () => state.user },
         });
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
               states: new OAuthStateStore({ sql }),
               github: null,
               githubApp: new GitHubAppRepository({
                  sql,
                  sealer: sealerFromKey(randomBytes(32).toString('base64')),
               }),
               publicUrl: 'http://localhost:4000',
               appUrl: 'http://localhost:3000',
               firstRunSetup: setup,
            })
         );
         return { app: createApp(registry), setup };
      }

      async function manifest(app: BerryApp, token: string | null): Promise<Response> {
         return app.request('/api/v1/integrations/github/app/manifest', {
            method: 'POST',
            headers: {
               'content-type': 'application/json',
               ...(token === null ? {} : { 'x-berry-setup-token': token }),
            },
            body: JSON.stringify({ name: 'Berry Local' }),
         });
      }

      before(() => {
         sql = openDatabase({ url: url! });
      });

      after(async () => {
         await sql`DELETE FROM integration_oauth_states WHERE workspace_id IS NULL`;
         await closeDatabase(sql);
      });

      test('the setup token stands in for a session while nobody has an account', async () => {
         const { app, setup } = appWith({ app: false, user: false });

         const response = await manifest(app, setup.token);
         const body = (await response.json()) as {
            postUrl: string;
            manifest: Record<string, unknown>;
         };

         assert.equal(response.status, 200);
         assert.equal(body.manifest.name, 'Berry Local');
         assert.equal(body.manifest.request_oauth_on_install, true);
         assert.ok(body.postUrl.startsWith('https://github.com/settings/apps/new?state='));
      });

      test('the state it starts names no workspace and no user', async () => {
         const { app, setup } = appWith({ app: false, user: false });
         const before = await count(sql);

         await manifest(app, setup.token);

         assert.equal(await count(sql), before + 1);
      });

      test('no response ever carries the token back', async () => {
         const { app, setup } = appWith({ app: false, user: false });

         const accepted = await manifest(app, setup.token);
         const acceptedBody = await accepted.text();
         const { app: second, setup: refused } = appWith({ app: false, user: true });
         const refusedBody = await (await manifest(second, refused.token)).text();

         assert.equal(acceptedBody.includes(setup.token), false);
         assert.equal(refusedBody.includes(refused.token), false);
         // Nor in a header, where a debugging aid would be just as readable.
         assert.equal(JSON.stringify([...accepted.headers]).includes(setup.token), false);
      });

      test('without the token the route is what it always was: a session route', async () => {
         const { app } = appWith({ app: false, user: false });

         assert.equal((await manifest(app, null)).status, 401);
      });

      test('a token that is not the one it minted is refused', async () => {
         const { app, setup } = appWith({ app: false, user: false });

         const response = await manifest(app, `${setup.token.slice(0, -1)}x`);

         assert.equal(response.status, 403);
         assert.equal(((await response.json()) as { error: { code: string } }).error.code,
            'SETUP_UNAVAILABLE');
      });

      test('the token is gone once a user exists', async () => {
         const { app, setup } = appWith({ app: false, user: true });

         assert.equal((await manifest(app, setup.token)).status, 403);
      });

      test('the token is gone once an App exists', async () => {
         const { app, setup } = appWith({ app: true, user: false });

         assert.equal((await manifest(app, setup.token)).status, 403);
      });

      test('the token is good once', async () => {
         const { app, setup } = appWith({ app: false, user: false });

         assert.equal((await manifest(app, setup.token)).status, 200);
         assert.equal((await manifest(app, setup.token)).status, 403);
      });
   }
);

async function count(sql: Sql): Promise<number> {
   const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM integration_oauth_states
       WHERE workspace_id IS NULL AND user_id IS NULL AND provider = 'github_app'`;
   return row!.n;
}
