import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropWorld, seedWorld, type World } from '../plugins/fixture.test-support.ts';
import { personalTokenScopes } from '../public-api/auth.ts';
import { parsePersonalToken } from '../auth/tokens.ts';
import { SecretsRepository } from './secrets.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('personal token scopes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'patscope');
   });
   after(async () => {
      await dropWorld(sql, world);
      await closeDatabase(sql);
   });

   test('scopes are stored with the token, and a token without scopes holds every scope', async () => {
      const secrets = new SecretsRepository(sql);
      const scoped = await secrets.createPersonalToken({
         userId: world.userId, name: 'ci', expiresAt: null, idempotencyKey: 'k'.repeat(20),
         fingerprint: Buffer.alloc(32, 'a'), scopes: ['issues:read'],
      });
      const open = await secrets.createPersonalToken({
         userId: world.userId, name: 'all', expiresAt: null, idempotencyKey: 'j'.repeat(20),
         fingerprint: Buffer.alloc(32, 'b'), scopes: null,
      });
      assert.deepEqual(scoped.token.scopes, ['issues:read']);
      assert.equal(open.token.scopes, null);
      const lookup = personalTokenScopes(sql);
      assert.deepEqual(await lookup(parsePersonalToken(scoped.secret).publicId), ['issues:read']);
      assert.equal(await lookup(parsePersonalToken(open.secret).publicId), null);
   });
});
