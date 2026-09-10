import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { resolveSquadLeader } from './squads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('squad leader', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   before(() => {
      sql = openDatabase({ url: url as string });
   });
   after(async () => {
      await closeDatabase(sql);
   });

   test('a squad that does not exist — or a server without squads — has nobody leading it', async () => {
      assert.equal(await resolveSquadLeader(sql, randomUUID(), randomUUID()), null);
   });
});
