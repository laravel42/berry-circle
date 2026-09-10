import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { AgentRepository } from '../agents/repository.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { RunLedger } from '../runs/ledger.ts';
import { RunRepository } from '../runs/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { agentMounts } from './agents.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent lifecycle', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(agentMounts({
         sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
         agents: new AgentRepository(sql),
         idempotency: new IdempotencyStore(sql),
         catalog: null,
         runs: new RunRepository(sql),
         ledger: new RunLedger({ sql }),
      }));
      app = createApp(registry);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('every workspace has a guide, and it is reachable by role', async () => {
      const res = await call(app, world.ownerToken, 'GET', '/api/v1/agents/guide');
      assert.equal(res.status, 200);
      assert.equal(res.body.systemRole, 'guide');
   });

   test('an archived agent leaves the list, appears under archived, and comes back on restore', async () => {
      assert.equal((await call(app, world.ownerToken, 'DELETE', `/api/v1/agents/${world.agentId}`)).status, 204);
      const live = await call(app, world.ownerToken, 'GET', '/api/v1/agents');
      assert.ok(!(live.body.nodes as { id: string }[]).some((a) => a.id === world.agentId));
      const archived = await call(app, world.ownerToken, 'GET', '/api/v1/agents?archived=true');
      assert.ok((archived.body.nodes as { id: string }[]).some((a) => a.id === world.agentId));
      const restored = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/restore`);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.archivedAt, null);
   });

   test('a copy is a new agent with the same instructions and skills', async () => {
      await sql`UPDATE agents SET instructions = 'Be terse.' WHERE id = ${world.agentId}`;
      const copy = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/copy`);
      assert.equal(copy.status, 201);
      assert.notEqual(copy.body.id, world.agentId);
      assert.equal(copy.body.instructions, 'Be terse.');
      assert.match(copy.body.name as string, /\(copy\)$/);
   });

   test('cancel-tasks cancels every queued run of the agent and lists them as tasks', async () => {
      await sql`
         INSERT INTO runs (issue_id, board_id, agent_id, requested_by)
         VALUES (${world.issueId}, ${world.boardId}, ${world.agentId}, ${world.ownerId})`;
      const tasks = await call(app, world.ownerToken, 'GET', `/api/v1/agents/${world.agentId}/tasks`);
      assert.equal((tasks.body.nodes as unknown[]).length, 1);
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.agentId}/cancel-tasks`);
      assert.deepEqual(res.body, { cancelled: 1 });
      const [row] = await sql`SELECT status FROM runs WHERE agent_id = ${world.agentId}`;
      assert.equal(row?.status, 'cancelled');
   });

   test('another workspace’s agent cannot be restored, copied or cancelled', async () => {
      for (const action of ['restore', 'copy', 'cancel-tasks']) {
         const res = await call(app, world.ownerToken, 'POST', `/api/v1/agents/${world.otherAgentId}/${action}`);
         assert.equal(res.status, 404, action);
      }
   });
});
