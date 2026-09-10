import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Sql } from '../db/pool.ts';
import { personalTokenResolver } from './credentials.ts';
import { generatePersonalToken } from './tokens.ts';

/**
 * Offline: the SQL client is a stub that answers each tagged-template call
 * with the next queued result, and records how many calls were made.
 */
function scriptedSql(results: unknown[][]): { sql: Sql; calls: () => number } {
   let calls = 0;
   const sql = (async () => {
      const next = results[calls] ?? [];
      calls += 1;
      return next;
   }) as unknown as Sql;
   return { sql, calls: () => calls };
}

const NOW = new Date('2026-09-10T12:00:00Z');

function tokenRow(secretHash: Buffer, extra: Record<string, unknown> = {}) {
   return {
      id: 'tok-1',
      secret_hash: secretHash,
      expires_at: null,
      revoked_at: null,
      user_id: '11111111-1111-1111-1111-111111111111',
      email: 'ada@berry.test',
      name: 'Ada',
      avatar_url: null,
      role: 'member',
      last_workspace_id: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...extra,
   };
}

test('the personal token resolver owns only the berry_pat_ namespace', () => {
   const resolver = personalTokenResolver(scriptedSql([]).sql);
   assert.equal(resolver.matches(generatePersonalToken().token), true);
   assert.equal(resolver.matches('berry_task_whatever'), false);
   assert.equal(resolver.matches('some-session-token'), false);
});

test('a live personal token resolves to its user and stamps last use', async () => {
   const issued = generatePersonalToken();
   const touched = Object.assign([], { count: 1 });
   const { sql, calls } = scriptedSql([[tokenRow(issued.secretHash)], touched]);
   const user = await personalTokenResolver(sql, () => NOW).resolve(issued.token);
   assert.equal(user.id, '11111111-1111-1111-1111-111111111111');
   assert.equal(user.email, 'ada@berry.test');
   assert.equal(calls(), 2);
});

test('a wrong secret, a revoked token and an expired token are all refused', async () => {
   const issued = generatePersonalToken();
   const other = generatePersonalToken();
   const cases: Array<[string, unknown[][]]> = [
      ['wrong secret', [[tokenRow(other.secretHash)]]],
      ['revoked', [[tokenRow(issued.secretHash, { revoked_at: '2026-09-01T00:00:00Z' })]]],
      ['expired', [[tokenRow(issued.secretHash, { expires_at: '2026-09-09T00:00:00Z' })]]],
      ['unknown', [[]]],
   ];
   for (const [label, results] of cases) {
      const { sql } = scriptedSql(results);
      await assert.rejects(personalTokenResolver(sql, () => NOW).resolve(issued.token), label);
   }
});

test('a malformed personal token is refused before any query runs', async () => {
   const { sql, calls } = scriptedSql([]);
   await assert.rejects(personalTokenResolver(sql).resolve('berry_pat_short'));
   assert.equal(calls(), 0);
});
