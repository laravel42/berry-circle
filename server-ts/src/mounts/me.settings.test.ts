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
 * The interface language is an account setting: it is stored beside theme and
 * timezone, so a second device opens in the language the first one chose.
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   '/api/v1/me/settings carries the interface locale',
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
            VALUES (${randomUUID()}, ${`locale-${suffix}@berry.test`}, 'Locale Test')
            RETURNING id`;
         const [other] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`locale-other-${suffix}@berry.test`}, 'Locale Other')
            RETURNING id`;
         userId = (row as { id: string }).id;
         otherUserId = (other as { id: string }).id;
         const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
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

      test('a user who never chose a language reads en, after the existing fields', async () => {
         const response = await call('/api/v1/me/settings');
         assert.equal(response.status, 200);
         const body = (await response.json()) as Record<string, unknown>;
         assert.deepEqual(Object.keys(body), ['theme', 'timezone', 'reducedMotion', 'locale']);
         assert.equal(body.locale, 'en');
      });

      test('a chosen locale is stored and survives an unrelated settings patch', async () => {
         const patched = await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'zh-Hans' }),
         });
         assert.equal(patched.status, 200);
         assert.equal(((await patched.json()) as { locale: string }).locale, 'zh-Hans');

         await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ reducedMotion: true }),
         });
         const bootstrap = await call('/api/v1/me/bootstrap');
         const user = ((await bootstrap.json()) as { user: { settings: { locale: string } } }).user;
         assert.equal(user.settings.locale, 'zh-Hans');
      });

      test('a locale Berry ships no catalogue for is refused on /locale and not stored', async () => {
         const refused = await call('/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'fr' }),
         });
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /"\/locale"/);
         const after = await call('/api/v1/me/settings');
         assert.equal(((await after.json()) as { locale: string }).locale, 'zh-Hans');
      });

      test("one user's locale never reaches another user's settings", async () => {
         // The first user chose zh-Hans above. The second never chose.
         const other = await callAs(otherToken, '/api/v1/me/settings');
         assert.equal(other.status, 200);
         assert.equal(((await other.json()) as { locale: string }).locale, 'en');

         await callAs(otherToken, '/api/v1/me/settings', {
            method: 'PATCH',
            body: JSON.stringify({ locale: 'ko' }),
         });
         const mine = await call('/api/v1/me/settings');
         assert.equal(((await mine.json()) as { locale: string }).locale, 'zh-Hans');
      });
   }
);
