import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import type { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { accountRoutes } from './account.ts';
import { meMounts } from './me.ts';
import type { IdentityRepository } from '../identity/repository.ts';

/**
 * The sessions settings read Better Auth's auth_sessions now; these pin that
 * they still list and delete only the caller's own rows.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('sessions settings on auth_sessions', { skip: !url }, () => {
   let sql: Sql;
   let app: BerryApp;
   const alice = randomUUID();
   const bob = randomUUID();
   const aliceSession = randomUUID();
   const bobSession = randomUUID();
   let aliceToken = '';

   before(async () => {
      sql = openDatabase({ url: url! });
      for (const [id, name] of [
         [alice, 'alice'],
         [bob, 'bob'],
      ] as const) {
         await sql`
            INSERT INTO users (id, email, name)
            VALUES (${id}, ${`${name}-${id}@berry.test`}, ${name})`;
      }
      for (const [id, userId] of [
         [aliceSession, alice],
         [bobSession, bob],
      ] as const) {
         await sql`
            INSERT INTO auth_sessions (id, user_id, token, expires_at)
            VALUES (${id}, ${userId}, ${randomUUID()}, now() + interval '1 day')`;
      }
      aliceToken = await issueTestToken(sql, alice);
      const sessions = new SessionService({
         sql,
         auth: null,
         bearer: [personalTokenResolver(sql)],
      });
      const registry = new Registry();
      registry.registerAll(
         meMounts({
            sessions,
            identity: {} as unknown as IdentityRepository,
            nested: accountRoutes({ sql, boards: {} as unknown as BoardRepository }),
         })
      );
      app = createApp(registry);
   });

   after(async () => {
      await sql`DELETE FROM users WHERE id IN (${alice}, ${bob})`;
      await closeDatabase(sql);
   });

   const auth = () => ({ authorization: `Bearer ${aliceToken}` });

   test("the list holds only the caller's sessions", async () => {
      const response = await app.request('/api/v1/me/sessions', { headers: auth() });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { nodes: Array<{ id: string }> };
      assert.deepEqual(
         body.nodes.map((node) => node.id),
         [aliceSession]
      );
   });

   test("deleting another user's session is a 404 and leaves it in place", async () => {
      const response = await app.request(`/api/v1/me/sessions/${bobSession}`, {
         method: 'DELETE',
         headers: auth(),
      });
      assert.equal(response.status, 404);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE id = ${bobSession}`;
      assert.equal(row?.n, 1);
   });

   test("deleting one's own session removes it", async () => {
      const response = await app.request(`/api/v1/me/sessions/${aliceSession}`, {
         method: 'DELETE',
         headers: auth(),
      });
      assert.equal(response.status, 204);
      const [row] = await sql`SELECT count(*)::int AS n FROM auth_sessions WHERE id = ${aliceSession}`;
      assert.equal(row?.n, 0);
   });
});
