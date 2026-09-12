import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { agentAccessGuard } from '../agents/access.ts';
import type { EnqueueInput } from '../agents/seams.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SquadRepository } from '../squads/repository.ts';
import {
   call,
   dropAgentLayerWorld,
   dropExtraUser,
   seedAgentLayerWorld,
   seedViewer,
   type AgentLayerWorld,
} from './agent-layer.fixture.ts';
import { squadMounts } from './squads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('squads mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;
   let squadId: string;
   const enqueued: EnqueueInput[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         squadMounts({
            sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
            sql,
            squads: new SquadRepository(sql),
            issues: new IssueRepository(sql),
            enqueue: async (_sql, input) => {
               enqueued.push(input);
               return { runId: randomUUID() };
            },
            agentAccess: agentAccessGuard(sql),
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an owner creates a squad led by one of the workspace agents', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/squads', {
         name: 'Core',
         description: '',
         leaderAgentId: world.agentId,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.leaderAgentId, world.agentId);
      squadId = res.body.id as string;
   });

   test('a squad cannot be led by another workspace’s agent', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/squads', {
         name: 'Foreign',
         leaderAgentId: world.otherAgentId,
      });
      assert.equal(res.status, 404);
   });

   test('the roster takes agents and people of the workspace', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/squads/${squadId}/members`, {
         members: [
            { type: 'agent', id: world.agentId, role: 'lead' },
            { type: 'user', id: world.memberId, role: 'reviewer' },
         ],
      });
      assert.equal(res.status, 200);
      assert.equal((res.body.members as unknown[]).length, 2);
   });

   test('a roster naming another workspace’s agent is refused', async () => {
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/squads/${squadId}/members`, {
         members: [{ type: 'agent', id: world.otherAgentId, role: 'member' }],
      });
      assert.equal(res.status, 422);
      assert.equal((res.body.error as { code: string }).code, 'VALIDATION_FAILED');
   });

   test('assigning an issue to the squad assigns its leader and queues the leader', async () => {
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/squads/${squadId}/assign`, {
         issueRef: world.issueId,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.leaderAgentId, world.agentId);
      assert.equal(typeof res.body.runId, 'string');
      const [row] = await sql`SELECT assignee_type, assignee_id FROM issues WHERE id = ${world.issueId}`;
      assert.equal(row?.assignee_type, 'agent');
      assert.equal(row?.assignee_id, world.agentId);
      assert.equal(enqueued.at(-1)?.source, 'squad');
      assert.equal(enqueued.at(-1)?.issueId, world.issueId);
      const [link] = await sql`SELECT squad_id FROM issue_squads WHERE issue_id = ${world.issueId}`;
      assert.equal(link?.squad_id, squadId);
   });

   test('the leader’s assign scope applies to assigning its squad', async () => {
      await sql`UPDATE agents SET assign_scope = 'admins' WHERE id = ${world.agentId}`;
      try {
         const res = await call(app, world.memberToken, 'POST', `/api/v1/squads/${squadId}/assign`, {
            issueRef: world.issueId,
         });
         assert.equal(res.status, 403);
         assert.equal((res.body.error as { code: string }).code, 'AGENT_ACCESS_DENIED');
      } finally {
         await sql`UPDATE agents SET assign_scope = 'everyone' WHERE id = ${world.agentId}`;
      }
   });

   test('a squad cannot be given an issue from another workspace the caller also belongs to', async () => {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${world.otherWorkspaceId}, ${world.ownerId}, 'member')`;
      const [board] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${world.otherWorkspaceId}, 'Other', ${`o-${randomUUID().slice(0, 8)}`},
                 ${world.outsiderId})
         RETURNING id`;
      const foreignIssueId = randomUUID();
      await sql`
         INSERT INTO issues (id, board_id, number, title, created_by)
         VALUES (${foreignIssueId}, ${board?.id as string}, 1, 'Foreign task', ${world.outsiderId})`;
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/squads/${squadId}/assign`, {
         issueRef: foreignIssueId,
      });
      assert.equal(res.status, 404);
      const [row] = await sql`SELECT assignee_id FROM issues WHERE id = ${foreignIssueId}`;
      assert.equal(row?.assignee_id, null);
   });

   test("a viewer is told 404 for a squad that is absent or another workspace's, and 403 only for this one", async () => {
      const viewer = await seedViewer(sql, world);
      const theirs = await call(app, world.outsiderToken, 'POST', '/api/v1/squads', {
         name: `Foreign ${randomUUID().slice(0, 8)}`,
         leaderAgentId: world.otherAgentId,
      });
      try {
         assert.equal(theirs.status, 201);
         const probes = [
            ['PATCH', '', { name: 'Renamed' }],
            ['DELETE', '', undefined],
            ['PUT', '/members', { members: [] }],
            ['POST', '/assign', { issueRef: world.issueId }],
         ] as const;
         for (const [method, suffix, body] of probes) {
            const probe = (id: string) => call(app, viewer.token, method, `/api/v1/squads/${id}${suffix}`, body);
            assert.equal((await probe(theirs.body.id as string)).status, 404, `${method} ${suffix}: another workspace's`);
            assert.equal((await probe(randomUUID())).status, 404, `${method} ${suffix}: none at all`);
            assert.equal((await probe(squadId)).status, 403, `${method} ${suffix}: this workspace's`);
         }
      } finally {
         // The outsider's workspace must be empty again for the tests after this one.
         if (theirs.body.id) await sql`DELETE FROM squads WHERE id = ${theirs.body.id as string}`;
         await dropExtraUser(sql, viewer.id);
      }
   });

   test('an outsider cannot read the squad', async () => {
      const res = await call(app, world.outsiderToken, 'GET', `/api/v1/squads/${squadId}`);
      assert.equal(res.status, 404);
      const list = await call(app, world.outsiderToken, 'GET', '/api/v1/squads');
      assert.deepEqual(list.body.nodes, []);
   });

   test('a squad can be created with a brief, an avatar and a roster in one go', async () => {
      const name = `Launch ${randomUUID().slice(0, 8)}`;
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/squads', {
         name,
         description: 'Ships the thing',
         instructions: 'Always leave a note on the task before handing it back.',
         avatarUrl: 'https://example.test/squad.png',
         leaderAgentId: world.agentId,
         members: [{ type: 'agent', id: world.agentId, role: 'lead' }],
      });
      try {
         assert.equal(created.status, 201);
         assert.equal(created.body.instructions, 'Always leave a note on the task before handing it back.');
         assert.equal(created.body.avatarUrl, 'https://example.test/squad.png');
         assert.equal(created.body.createdBy, world.ownerId);
         const members = created.body.members as Array<Record<string, unknown>>;
         assert.equal(members.length, 1);
         // A member row carries what the members tab shows beside the name.
         assert.equal(members[0]?.id, world.agentId);
         assert.equal(members[0]?.role, 'lead');
         assert.equal(typeof members[0]?.status, 'string');
         assert.equal(typeof members[0]?.openIssues, 'number');
         assert.ok('lastActiveAt' in (members[0] as object));

         const patched = await call(app, world.ownerToken, 'PATCH', `/api/v1/squads/${created.body.id as string}`, {
            instructions: 'Rewritten.',
         });
         assert.equal(patched.status, 200);
         assert.equal(patched.body.instructions, 'Rewritten.');
      } finally {
         if (created.body.id) await sql`DELETE FROM squads WHERE id = ${created.body.id as string}`;
      }
   });

   test('an initial roster naming another workspace’s agent leaves no squad behind', async () => {
      const name = `Doomed ${randomUUID().slice(0, 8)}`;
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/squads', {
         name,
         leaderAgentId: world.agentId,
         members: [{ type: 'agent', id: world.otherAgentId, role: 'member' }],
      });
      assert.equal(res.status, 422);
      assert.equal((res.body.error as { code: string }).code, 'VALIDATION_FAILED');
      const rows = await sql`SELECT id FROM squads WHERE name = ${name}`;
      assert.equal(rows.length, 0, 'the squad and its roster are written together or not at all');
   });

   test('an archived squad leaves the list', async () => {
      assert.equal((await call(app, world.ownerToken, 'DELETE', `/api/v1/squads/${squadId}`)).status, 204);
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/squads');
      assert.ok(!(list.body.nodes as { id: string }[]).some((squad) => squad.id === squadId));
   });
});
