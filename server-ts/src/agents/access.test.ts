import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { ApiError } from '../http/errors.ts';
import { agentAccessGuard, canUseAgent } from './access.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent access scopes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   const can = (userId: string, action: 'assign' | 'mention') =>
      canUseAgent(sql, { workspaceId: world.workspaceId, agentId: world.agentId, userId, action });

   test('by default every member may assign and mention', async () => {
      assert.equal(await can(world.memberId, 'assign'), true);
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('admins-only keeps members out and owners in', async () => {
      await sql`UPDATE agents SET assign_scope = 'admins' WHERE id = ${world.agentId}`;
      assert.equal(await can(world.memberId, 'assign'), false);
      assert.equal(await can(world.ownerId, 'assign'), true);
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('listed lets exactly the listed members in', async () => {
      await sql`UPDATE agents SET mention_scope = 'listed' WHERE id = ${world.agentId}`;
      assert.equal(await can(world.memberId, 'mention'), false);
      await sql`INSERT INTO agent_access_members (agent_id, user_id, workspace_id)
                VALUES (${world.agentId}, ${world.memberId}, ${world.workspaceId})`;
      assert.equal(await can(world.memberId, 'mention'), true);
   });

   test('someone outside the workspace never may', async () => {
      assert.equal(await can(world.outsiderId, 'mention'), false);
   });

   test('the issues guard refuses an assignment the scope forbids, with a stable code', async () => {
      const guard = agentAccessGuard(sql);
      await sql`UPDATE agents SET assign_scope = 'admins' WHERE id = ${world.agentId}`;
      await assert.rejects(
         guard.assertCanAssign({ workspaceId: world.workspaceId, agentId: world.agentId, userId: world.memberId }),
         (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'AGENT_ACCESS_DENIED'
      );
      await guard.assertCanAssign({ workspaceId: world.workspaceId, agentId: world.agentId, userId: world.ownerId });
   });
});
