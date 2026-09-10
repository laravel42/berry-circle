import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { EnqueueInput } from '../agents/seams.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import type { Run } from '../runs/ledger.ts';
import { notifyRunTerminal } from '../runs/terminal-hooks.ts';
import { squadBriefing } from './briefing.ts';
import { SquadRepository } from './repository.ts';
import { delegateToMember, registerSquadRetrigger } from './retrigger.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('squad delegation', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let memberAgentId: string;
   let squadId: string;
   const calls: EnqueueInput[] = [];
   let off: () => void = () => undefined;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const [member] = await sql`
         INSERT INTO agents (workspace_id, name, status) VALUES (${world.workspaceId}, 'Tester', 'available')
         RETURNING id`;
      memberAgentId = member?.id as string;
      const squads = new SquadRepository(sql);
      const squad = await squads.create(
         world.workspaceId,
         { name: 'Core', description: '', leaderAgentId: world.agentId },
         world.ownerId
      );
      squadId = squad.id;
      await squads.setMembers(world.workspaceId, squadId, [{ type: 'agent', id: memberAgentId, role: 'tester' }]);
      await squads.recordAssignment(world.workspaceId, squadId, world.issueId, world.ownerId);
      off = registerSquadRetrigger({
         sql,
         enqueue: async (_sql, input) => {
            calls.push(input);
            return { runId: 'r' };
         },
      });
   });
   after(async () => {
      off();
      await sql`DELETE FROM issues WHERE board_id = ${world.boardId} AND id <> ${world.issueId}`;
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the leader’s briefing names the squad and every member with a role', async () => {
      const briefing = await squadBriefing(sql, world.issueId);
      assert.match(briefing ?? '', /Core/);
      assert.match(briefing ?? '', /Tester \(agent, tester\)/);
      assert.match(briefing ?? '', new RegExp(memberAgentId));
   });

   test('an issue no squad owns has no briefing', async () => {
      assert.equal(await squadBriefing(sql, '99999999-9999-4999-8999-999999999999'), null);
   });

   test('delegating creates a sub-issue assigned to the member, and its finishing wakes the leader once', async () => {
      const child = await delegateToMember(
         { sql, issues: new IssueRepository(sql) },
         {
            workspaceId: world.workspaceId,
            parentIssueId: world.issueId,
            memberAgentId,
            title: 'Write the tests',
            description: 'Cover the parser.',
         }
      );
      const [row] = await sql`SELECT assignee_type, assignee_id FROM issues WHERE id = ${child.issueId}`;
      assert.equal(row?.assignee_type, 'agent');
      assert.equal(row?.assignee_id, memberAgentId);

      const run = {
         id: '11111111-1111-4111-8111-111111111111',
         issueId: child.issueId,
         status: 'succeeded',
         summary: 'done',
      } as unknown as Run;
      await notifyRunTerminal(run);
      await notifyRunTerminal(run);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.agentId, world.agentId);
      assert.equal(calls[0]?.issueId, world.issueId);
      assert.equal(calls[0]?.source, 'squad');
      assert.match(calls[0]?.prompt ?? '', /<member_result>\ndone\n<\/member_result>/);
   });

   test('delegating to someone outside the squad is refused', async () => {
      await assert.rejects(
         delegateToMember(
            { sql, issues: new IssueRepository(sql) },
            {
               workspaceId: world.workspaceId,
               parentIssueId: world.issueId,
               memberAgentId: world.otherAgentId,
               title: 'x',
               description: '',
            }
         )
      );
   });

   test('a refused wake-up (busy parent) releases the claim so it can be retried', async () => {
      off();
      let fail = true;
      const seen: EnqueueInput[] = [];
      off = registerSquadRetrigger({
         sql,
         enqueue: async (_sql, input) => {
            if (fail) throw new Error('active run');
            seen.push(input);
            return { runId: 'r2' };
         },
      });
      const child = await delegateToMember(
         { sql, issues: new IssueRepository(sql) },
         { workspaceId: world.workspaceId, parentIssueId: world.issueId, memberAgentId, title: 'Second', description: '' }
      );
      const run = {
         id: '44444444-4444-4444-8444-444444444444',
         issueId: child.issueId,
         status: 'succeeded',
         summary: null,
      } as unknown as Run;
      const errors: unknown[] = [];
      await notifyRunTerminal(run, (error) => errors.push(error));
      assert.equal(errors.length, 1);
      const [row] = await sql`SELECT last_notified_run_id FROM squad_delegations WHERE child_issue_id = ${child.issueId}`;
      assert.equal(row?.last_notified_run_id, null);
      fail = false;
      await notifyRunTerminal(run);
      assert.equal(seen.length, 1);
   });
});
