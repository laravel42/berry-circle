import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { AgentProfileRepository } from '../agents/profile.ts';
import { AgentRepository } from '../agents/repository.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { agentMounts } from './agents.ts';

/**
 * `GET /api/v1/agents/roster`: the facts the agents list draws per row that do
 * not live on the agent — its owner, its runtime, its load, and a short daily
 * history.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

interface RosterNode {
   agentId: string;
   ownerId: string | null;
   ownerName: string | null;
   runtimeId: string | null;
   runtimeName: string | null;
   runtimeStatus: string | null;
   running: number;
   queued: number;
   totalRuns: number;
   lastActiveAt: string | null;
   activity: { day: string; runs: number; failed: number }[];
}

describe('agent roster', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   const roster = async (token: string, query = ''): Promise<{ status: number; nodes: RosterNode[] }> => {
      const res = await call(app, token, 'GET', `/api/v1/agents/roster${query}`);
      return { status: res.status, nodes: (res.body.nodes as RosterNode[] | undefined) ?? [] };
   };

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         agentMounts({
            sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
            agents: new AgentRepository(sql),
            idempotency: new IdempotencyStore(sql),
            catalog: null,
            profile: new AgentProfileRepository({
               sql,
               sealer: sealerFromKey(randomBytes(32).toString('base64')),
            }),
         })
      );
      app = createApp(registry);

      // One finished run and one waiting one, so the counts and the day
      // buckets have something real to report rather than only zeroes.
      await sql`
         INSERT INTO runs (id, workspace_id, issue_id, board_id, agent_id, status, completed_at)
         VALUES (${randomUUID()}, ${world.workspaceId}, ${world.issueId}, ${world.boardId},
                 ${world.agentId}, 'succeeded', now())`;
      await sql`
         INSERT INTO runs (id, workspace_id, issue_id, board_id, agent_id, status)
         VALUES (${randomUUID()}, ${world.workspaceId}, ${world.issueId}, ${world.boardId},
                 ${world.agentId}, 'queued')`;
   });

   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('reports load, run totals and a filled day series for every agent', async () => {
      const { status, nodes } = await roster(world.ownerToken);
      assert.equal(status, 200);

      const entry = nodes.find((node) => node.agentId === world.agentId);
      assert.ok(entry, 'the seeded agent is on the roster');
      assert.equal(entry.queued, 1);
      assert.equal(entry.running, 0);
      assert.equal(entry.totalRuns, 2);
      assert.ok(entry.lastActiveAt, 'a finished run sets last activity');

      // Seven points by default, oldest first, one per day with no gaps.
      assert.equal(entry.activity.length, 7);
      const days = entry.activity.map((point) => point.day);
      assert.deepEqual(days, [...days].sort(), 'the series is in date order');
      assert.equal(new Set(days).size, 7, 'each day appears once');
      assert.equal(
         entry.activity.reduce((total, point) => total + point.runs, 0),
         2,
         'both runs land in the window'
      );
      assert.equal(entry.activity.at(-1)?.failed, 0, 'neither run failed');
   });

   test('an agent with no runtime bound reports none rather than omitting the field', async () => {
      const { nodes } = await roster(world.ownerToken);
      const entry = nodes.find((node) => node.agentId === world.agentId);
      assert.equal(entry?.runtimeId, null);
      assert.equal(entry?.runtimeName, null);
      assert.equal(entry?.runtimeStatus, null);
   });

   test('the agent an owner created carries that owner', async () => {
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/agents', {
         name: `Owned ${randomUUID().slice(0, 8)}`,
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.ownerId, world.ownerId);

      const { nodes } = await roster(world.ownerToken);
      const entry = nodes.find((node) => node.agentId === created.body.id);
      assert.equal(entry?.ownerId, world.ownerId);
      assert.equal(typeof entry?.ownerName, 'string');
   });

   test('a member of the workspace may read it; an outsider never sees its agents', async () => {
      const asMember = await roster(world.memberToken);
      assert.equal(asMember.status, 200);
      assert.ok(asMember.nodes.some((node) => node.agentId === world.agentId));

      const asOutsider = await roster(world.outsiderToken);
      assert.equal(asOutsider.status, 200);
      assert.equal(
         asOutsider.nodes.some((node) => node.agentId === world.agentId),
         false,
         'the outsider’s own workspace roster carries none of this one’s agents'
      );
   });

   test('days is validated rather than clamped silently', async () => {
      assert.equal((await roster(world.ownerToken, '?days=1')).nodes[0]?.activity.length, 1);
      assert.equal((await roster(world.ownerToken, '?days=0')).status, 400);
      assert.equal((await roster(world.ownerToken, '?days=91')).status, 400);
      assert.equal((await roster(world.ownerToken, '?days=week')).status, 400);
   });
});
