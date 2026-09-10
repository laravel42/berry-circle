import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { fireAutopilot, type FireInput } from '../autopilots/fire.ts';
import { AutopilotRepository } from '../autopilots/repository.ts';
import { cleanupWorkspace, seedWorkspace, testSealer, type Fixture } from '../autopilots/test-fixture.ts';
import { createLogger } from '../observability/log.ts';
import { AutopilotScheduler } from './scheduler.ts';

/**
 * The scheduler's promise is "each slot fires once, on however many
 * servers". That is a property of the unique index and the claim order, so
 * the database is real and two schedulers race for the same slot.
 *
 * Other files' triggers may be due in the same database; every assertion
 * filters to this file's autopilots.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;
const MANUAL = { pollMs: 3_600_000 };

describe('autopilot scheduler', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let repo: AutopilotRepository;
   let fixture: Fixture;
   let fired: FireInput[];

   before(async () => {
      sql = openDatabase({ url: url as string });
      repo = new AutopilotRepository({ sql, sealer: testSealer() });
      fixture = await seedWorkspace(sql, 'sched');
   });

   after(async () => {
      await cleanupWorkspace(sql, fixture);
      await closeDatabase(sql);
   });

   function build(): AutopilotScheduler {
      return new AutopilotScheduler({
         sql,
         logger: createLogger('scheduler-test'),
         ...MANUAL,
         fire: async (input) => {
            fired.push(input);
            return fireAutopilot(
               {
                  sql,
                  issues: new IssueRepository(sql),
                  enqueue: async () => ({ runId: randomUUID() }),
                  resolveSquadLeader: async () => null,
               },
               input
            );
         },
      });
   }

   async function dueAutopilot(): Promise<{ autopilotId: string; triggerId: string }> {
      const autopilot = await repo.create(
         fixture.workspaceId,
         {
            name: `Scheduled ${randomUUID().slice(0, 6)}`, description: null,
            assigneeType: 'agent', assigneeId: fixture.agentId, promptTemplate: 'Tick.',
            executionMode: 'create_issue', boardId: fixture.boardId, issueId: null,
            quotaPeriod: 'none', quotaMax: null,
         },
         fixture.userId
      );
      const trigger = await repo.addCronTrigger(fixture.workspaceId, autopilot.id, {
         expression: '*/5 * * * *', timezone: 'UTC', enabled: true,
      });
      await sql`
         UPDATE autopilot_triggers SET next_fire_at = date_trunc('minute', now()) - interval '5 minutes'
          WHERE id = ${trigger.id}`;
      return { autopilotId: autopilot.id, triggerId: trigger.id };
   }

   test('two schedulers reaching for one due slot fire it exactly once', async () => {
      fired = [];
      const { autopilotId, triggerId } = await dueAutopilot();
      await Promise.all([build().tick(), build().tick()]);

      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 1);
      const claims = await sql`SELECT autopilot_run_id FROM sys_cron_executions WHERE trigger_id = ${triggerId}`;
      assert.equal(claims.length, 1);
      assert.ok(claims[0]?.autopilot_run_id, 'the claim points at the run it produced');

      const [trigger] = await sql`SELECT next_fire_at, last_fired_at FROM autopilot_triggers WHERE id = ${triggerId}`;
      assert.ok(Date.parse(String(trigger?.next_fire_at)) > Date.now(), 'the next slot is in the future');
      assert.ok(trigger?.last_fired_at);

      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 1, 'not again');
   });

   test('a paused autopilot is not fired by its schedule', async () => {
      fired = [];
      const { autopilotId } = await dueAutopilot();
      await repo.update(fixture.workspaceId, autopilotId, { status: 'paused' }, fixture.userId);
      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 0);
   });

   test('a disabled trigger is not fired', async () => {
      fired = [];
      const { autopilotId, triggerId } = await dueAutopilot();
      await sql`UPDATE autopilot_triggers SET enabled = false WHERE id = ${triggerId}`;
      await build().tick();
      assert.equal(fired.filter((input) => input.autopilotId === autopilotId).length, 0);
   });
});
