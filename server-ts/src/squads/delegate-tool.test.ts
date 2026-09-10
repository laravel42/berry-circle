import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import type { AgentToolContext } from '../runtime/agent-tools/registry.ts';
import { delegateTool } from './delegate-tool.ts';
import { SquadRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('the delegate_to_member tool', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let issues: IssueRepository;
   let memberAgentId: string;

   const context = (task: Partial<AgentToolContext['task']>): AgentToolContext => ({
      sql,
      storage: null,
      issues,
      task: {
         tokenId: 'token',
         runId: 'run',
         workspaceId: world.workspaceId,
         agentId: world.agentId,
         issueId: world.issueId,
         boardId: world.boardId,
         scopes: ['task:read', 'task:write'],
         ...task,
      },
   });

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      issues = new IssueRepository(sql);
      const [member] = await sql`
         INSERT INTO agents (workspace_id, name, status) VALUES (${world.workspaceId}, 'Delegate', 'available')
         RETURNING id`;
      memberAgentId = member?.id as string;
      const squads = new SquadRepository(sql);
      const squad = await squads.create(
         world.workspaceId,
         { name: 'Delegators', description: '', leaderAgentId: world.agentId },
         world.ownerId
      );
      await squads.setMembers(world.workspaceId, squad.id, [{ type: 'agent', id: memberAgentId, role: 'builder' }]);
      await squads.recordAssignment(world.workspaceId, squad.id, world.issueId, world.ownerId);
   });
   after(async () => {
      await sql`DELETE FROM issues WHERE board_id = ${world.boardId} AND id <> ${world.issueId}`;
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the leader delegates a real sub-issue to a member', async () => {
      const tool = delegateTool({ sql, issues });
      const created = (await tool.handler(context({}), {
         memberId: memberAgentId,
         title: 'Build the parser',
         description: '',
      })) as { issueId: string };
      const [child] = await sql`
         SELECT parent_id, assignee_type, assignee_id FROM issues WHERE id = ${created.issueId}`;
      assert.equal(child?.parent_id, world.issueId);
      assert.equal(child?.assignee_type, 'agent');
      assert.equal(child?.assignee_id, memberAgentId);
   });

   test('a member cannot delegate, and neither can a task from another workspace', async () => {
      const tool = delegateTool({ sql, issues });
      const args = { memberId: memberAgentId, title: 'Not allowed', description: '' };
      await assert.rejects(tool.handler(context({ agentId: memberAgentId }), args), /only the squad leader/);
      await assert.rejects(
         tool.handler(context({ workspaceId: world.otherWorkspaceId }), args),
         /only the squad leader/
      );
      await assert.rejects(tool.handler(context({ issueId: null }), args), /needs a task on an issue/);
   });
});
