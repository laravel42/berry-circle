import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { IdentityRepository } from '../identity/repository.ts';
import { meMounts } from './me.ts';

/**
 * "About you" on a profile: free text a person writes about themselves that
 * agents are given as context.
 *
 * The cases worth pinning are the ones a sparse patch gets wrong: clearing it
 * has to be distinguishable from leaving it alone, an unrelated patch must not
 * erase it, and it is a person's own — never visible on another account.
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   '/api/v1/me carries an "about you" description',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let userId: string;
      let otherUserId: string;
      let token: string;
      let otherToken: string;
      let app: ReturnType<typeof createApp>;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);
         const [row] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`about-${suffix}@berry.test`}, 'About Test')
            RETURNING id`;
         const [other] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`about-other-${suffix}@berry.test`}, 'About Other')
            RETURNING id`;
         userId = (row as { id: string }).id;
         otherUserId = (other as { id: string }).id;
         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         token = await issueTestToken(sql, userId);
         otherToken = await issueTestToken(sql, otherUserId);
         const registry = new Registry();
         registry.registerAll(meMounts({ sessions, identity: new IdentityRepository(sql) }));
         app = createApp(registry);
      });

      after(async () => {
         if (!sql) return;
         for (const id of [userId, otherUserId]) {
            if (!id) continue;
            await sql`DELETE FROM sessions WHERE user_id = ${id}`;
            await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      const callAs = (bearer: string, path: string, init: RequestInit = {}) =>
         Promise.resolve(
            app.request(path, {
               ...init,
               headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            })
         );
      const call = (path: string, init: RequestInit = {}) => callAs(token, path, init);
      const patch = (body: unknown, bearer = token) =>
         callAs(bearer, '/api/v1/me', { method: 'PATCH', body: JSON.stringify(body) });

      test('a profile that has never had one reads null', async () => {
         const response = await call('/api/v1/me');
         assert.equal(response.status, 200);
         assert.equal(((await response.json()) as { description: unknown }).description, null);
      });

      test('a description is stored, and an unrelated patch leaves it alone', async () => {
         const written = await patch({ description: '  I maintain the billing service.  ' });
         assert.equal(written.status, 200);
         // Trimmed on the way in, so a stray newline is not part of what an
         // agent is told about this person.
         assert.equal(
            ((await written.json()) as { description: string }).description,
            'I maintain the billing service.'
         );

         const renamed = await patch({ name: 'About Renamed' });
         assert.equal(renamed.status, 200);
         const body = (await renamed.json()) as { name: string; description: string };
         assert.equal(body.name, 'About Renamed');
         assert.equal(body.description, 'I maintain the billing service.');
      });

      test('an explicit null clears it, and so does a blank string', async () => {
         await patch({ description: 'Something about me.' });

         const cleared = await patch({ description: null });
         assert.equal(cleared.status, 200);
         assert.equal(((await cleared.json()) as { description: unknown }).description, null);

         await patch({ description: 'Back again.' });
         const blanked = await patch({ description: '   ' });
         assert.equal(blanked.status, 200);
         // Deleting the text means "I have not written one", not "mine is the
         // empty string" — a stored blank would read as a written answer.
         assert.equal(((await blanked.json()) as { description: unknown }).description, null);
      });

      test('a patch naming no field at all is still refused', async () => {
         const refused = await patch({});
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /empty_patch/);
      });

      test('over 2,000 characters is refused and nothing is stored', async () => {
         await patch({ description: 'Kept.' });

         const refused = await patch({ description: 'x'.repeat(2001) });
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /"\/description"/);

         const unchanged = await call('/api/v1/me');
         assert.equal(((await unchanged.json()) as { description: string }).description, 'Kept.');
      });

      test('exactly 2,000 characters is accepted', async () => {
         const accepted = await patch({ description: 'y'.repeat(2000) });
         assert.equal(accepted.status, 200);
         assert.equal(((await accepted.json()) as { description: string }).description.length, 2000);
      });

      test("one person's description never appears on another's profile", async () => {
         await patch({ description: 'Mine alone.' });

         const other = await callAs(otherToken, '/api/v1/me');
         assert.equal(((await other.json()) as { description: unknown }).description, null);

         await patch({ description: 'Theirs alone.' }, otherToken);
         const mine = await call('/api/v1/me');
         assert.equal(((await mine.json()) as { description: string }).description, 'Mine alone.');
      });

      test('bootstrap carries it, so the shell has it without a second call', async () => {
         await patch({ description: 'On the bootstrap.' });
         const response = await call('/api/v1/me/bootstrap');
         const body = (await response.json()) as { user: { description: string } };
         assert.equal(body.user.description, 'On the bootstrap.');
      });
   }
);
