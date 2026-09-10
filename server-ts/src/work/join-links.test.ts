import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import {
   JoinLinkInvalid,
   acceptJoinLink,
   createJoinLink,
   joinLinkCreateSchema,
   listJoinLinks,
   lookupJoinLink,
   revokeJoinLink,
} from './join-links.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('join links', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let joinerId = '';
   let latecomerId = '';
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'join');
      const [joiner] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`joiner-${randomUUID().slice(0, 8)}@berry.test`}, 'Joiner')
         RETURNING id`;
      joinerId = joiner?.id as string;
      const [latecomer] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`latecomer-${randomUUID().slice(0, 8)}@berry.test`}, 'Latecomer')
         RETURNING id`;
      latecomerId = latecomer?.id as string;
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await sql`DELETE FROM users WHERE id = ${joinerId}`;
      await sql`DELETE FROM users WHERE id = ${latecomerId}`;
      await closeDatabase(sql);
   });

   test('a link joins once per person, counts its use, and stops at its limit', async () => {
      const { link, token } = await createJoinLink(sql, world.workspaceId, world.ownerId, joinLinkCreateSchema.parse({ role: 'viewer', maxUses: 1 }));
      assert.match(token, /^berry_join_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual((await lookupJoinLink(sql, token))?.role, 'viewer');
      assert.deepEqual(await acceptJoinLink(sql, token, joinerId), { workspaceId: world.workspaceId, role: 'viewer', joined: true });
      assert.deepEqual(await acceptJoinLink(sql, token, joinerId), { workspaceId: world.workspaceId, role: 'viewer', joined: false });
      const listed = await listJoinLinks(sql, world.workspaceId);
      assert.equal(listed.find((entry) => entry.id === link.id)?.useCount, 1);
      assert.equal(await lookupJoinLink(sql, token), null);
      // A new person, not an existing member: members get joined:false from any link.
      await assert.rejects(acceptJoinLink(sql, token, latecomerId), JoinLinkInvalid);
   });

   test('a revoked link and an unknown token are both invalid', async () => {
      const { link, token } = await createJoinLink(sql, world.workspaceId, world.ownerId, joinLinkCreateSchema.parse({}));
      assert.equal(await revokeJoinLink(sql, world.workspaceId, link.id), true);
      assert.equal(await lookupJoinLink(sql, token), null);
      await assert.rejects(acceptJoinLink(sql, `berry_join_${'a'.repeat(43)}`, joinerId), JoinLinkInvalid);
   });
});
