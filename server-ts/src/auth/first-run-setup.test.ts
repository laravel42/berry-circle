import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { FirstRunSetup, databaseWorld } from './first-run-setup.ts';

/**
 * The one-time token that lets the very first person create the GitHub App.
 *
 * Creating the App needs a signed-in user, and signing in needs the App: the
 * token is the only way out of that circle. It is therefore narrow on purpose —
 * good while nobody has an account and no App exists, once, and never again.
 */

function world(state: { app: boolean; user: boolean }) {
   return { hasApp: async () => state.app, hasUser: async () => state.user };
}

describe('first-run setup', () => {
   test('is open while there is no App and no user', async () => {
      const setup = new FirstRunSetup({ world: world({ app: false, user: false }) });

      assert.equal(await setup.available(), true);
      assert.equal(await setup.claim(setup.token), true);
   });

   test('mints a token nobody could guess', () => {
      const tokens = new Set(
         Array.from({ length: 8 }, () => new FirstRunSetup({ world: world({ app: false, user: false }) }).token)
      );

      assert.equal(tokens.size, 8);
      for (const token of tokens) assert.ok(token.length >= 32);
   });

   test('is closed once an App exists', async () => {
      const setup = new FirstRunSetup({ world: world({ app: true, user: false }) });

      assert.equal(await setup.available(), false);
      assert.equal(await setup.claim(setup.token), false);
   });

   test('is closed once a user exists', async () => {
      const setup = new FirstRunSetup({ world: world({ app: false, user: true }) });

      assert.equal(await setup.available(), false);
      assert.equal(await setup.claim(setup.token), false);
   });

   test('the token is good once and never again', async () => {
      const setup = new FirstRunSetup({ world: world({ app: false, user: false }) });

      assert.equal(await setup.claim(setup.token), true);
      assert.equal(await setup.claim(setup.token), false);
      assert.equal(await setup.available(), false);
   });

   test('refuses a token that is not the one it minted', async () => {
      const setup = new FirstRunSetup({ world: world({ app: false, user: false }) });

      assert.equal(await setup.claim(''), false);
      assert.equal(await setup.claim(null), false);
      assert.equal(await setup.claim(`${setup.token}x`), false);
      assert.equal(await setup.claim('a'.repeat(setup.token.length)), false);
      // Refusing a wrong one does not spend the right one.
      assert.equal(await setup.claim(setup.token), true);
   });
});

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   'what first-run setup asks the database',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      const users: string[] = [];

      before(() => {
         sql = openDatabase({ url: url! });
      });

      after(async () => {
         for (const id of users) await sql`DELETE FROM users WHERE id = ${id}`;
         await closeDatabase(sql);
      });

      test('a person counts as a user; the system actor does not', async () => {
         const reader = databaseWorld(sql);
         const [people] = await sql<Array<{ people: string }>>`
            SELECT count(*) AS people FROM users
             WHERE id <> '00000000-0000-4000-8000-000000000001'::uuid`;

         assert.equal(await reader.hasUser(), Number(people!.people) > 0);

         const id = randomUUID();
         await sql`
            INSERT INTO users (id, email, name)
            VALUES (${id}, ${`setup-${id.slice(0, 8)}@berry.test`}, 'Setup')`;
         users.push(id);

         assert.equal(await reader.hasUser(), true);
      });

      test('reports whether this deployment holds an App', async () => {
         const reader = databaseWorld(sql);
         const [apps] = await sql<Array<{ apps: string }>>`
            SELECT count(*) AS apps FROM github_apps`;

         assert.equal(await reader.hasApp(), Number(apps!.apps) > 0);
      });
   }
);
