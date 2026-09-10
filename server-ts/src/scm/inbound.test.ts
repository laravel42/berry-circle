import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Sql } from '../db/pool.ts';
import type { Logger } from '../observability/log.ts';
import { ScmInbound } from './inbound.ts';
import type { ScmLinkRepository } from './links.ts';

/**
 * Which handler an inbound event reaches.
 *
 * Offline: the events routed here never touch the database on the way to the
 * GitHub delegate, so a SQL handle that fails if called is the proof.
 */

const refusingSql = (() => {
   throw new Error('no SQL expected');
}) as unknown as Sql;
const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;
const links = {} as ScmLinkRepository;

describe('routing an inbound event', () => {
   test('checks and installations go to the GitHub delegate', async () => {
      const seen: string[] = [];
      const inbound = new ScmInbound({
         sql: refusingSql,
         links,
         logger,
         github: {
            handles: () => true,
            apply: async (event) => {
               seen.push(event);
               return { applied: true, reason: 'delegate' };
            },
         },
      });
      for (const event of ['check_run', 'check_suite', 'installation']) {
         assert.deepEqual(await inbound.apply(event, {}), { applied: true, reason: 'delegate' });
      }
      assert.deepEqual(seen, ['check_run', 'check_suite', 'installation']);
   });

   test('without a delegate they are reported as unhandled, not failed', async () => {
      const inbound = new ScmInbound({ sql: refusingSql, links, logger });
      const result = await inbound.apply('check_run', {});
      assert.equal(result.applied, false);
      assert.match(result.reason, /unhandled/);
   });
});
