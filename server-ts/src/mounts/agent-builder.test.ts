import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { AgentBuilder } from '../agents/builder.ts';
import { AgentRepository } from '../agents/repository.ts';
import type { CompleteFn, CompletionRequest } from '../agents/seams.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { SkillRepository } from '../skills/repository.ts';
import { agentBuilderMounts } from './agent-builder.ts';
import {
   call,
   dropAgentLayerWorld,
   dropExtraUser,
   seedAgentLayerWorld,
   seedViewer,
   type AgentLayerWorld,
} from './agent-layer.fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

function buildApp(sql: Sql, complete: CompleteFn | null): BerryApp {
   const registry = new Registry();
   registry.registerAll(
      agentBuilderMounts({
         sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
         sql,
         builder: new AgentBuilder({
            sql,
            complete,
            skills: new SkillRepository(sql),
            agents: new AgentRepository(sql),
            mcp: new McpServerRepository({ sql, sealer: sealerFromKey(randomBytes(32).toString('base64')) }),
         }),
      })
   );
   return createApp(registry);
}

describe('agent builder', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;
   let sessionId = '';
   let draftId = '';
   const prompts: string[] = [];
   const complete: CompleteFn = async <T>(request: CompletionRequest<T>): Promise<T> => {
      prompts.push(request.prompt);
      return request.schema.parse({
         name: 'Release Notes Writer',
         description: 'Writes release notes.',
         instructions: 'Read merged PRs and write notes.',
         skills: ['notes-style', 'does-not-exist'],
         mcp: [{ name: 'changelog', url: 'https://c.test/mcp', transport: 'streamable_http' }],
         model: null,
      });
   };

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      app = buildApp(sql, complete);
      await new SkillRepository(sql).create(
         world.workspaceId,
         { name: 'notes-style', description: '', content: '', labels: [], files: [] },
         world.ownerId
      );
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   const agentCount = async (): Promise<number> => {
      const [row] = await sql`SELECT count(*)::int AS n FROM agents WHERE workspace_id = ${world.workspaceId}`;
      return Number(row?.n);
   };

   test('a turn returns a validated draft and names skills the workspace lacks', async () => {
      const session = await call(app, world.ownerToken, 'POST', '/api/v1/agent-builder/sessions');
      assert.equal(session.status, 201);
      assert.equal(session.body.status, 'drafting');
      const turn = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${session.body.id as string}/turns`, {
         prompt: 'An agent that writes release notes',
      });
      assert.equal(turn.status, 201);
      assert.equal((turn.body.draft as { name: string }).name, 'Release Notes Writer');
      assert.deepEqual(turn.body.unknownSkills, ['does-not-exist']);
      sessionId = session.body.id as string;
      draftId = turn.body.draftId as string;
   });

   test('a second turn carries the previous draft into the prompt', async () => {
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/turns`, {
         prompt: 'Make it terse',
      });
      assert.equal(res.status, 201);
      assert.match(prompts.at(-1) ?? '', /Release Notes Writer/);
      assert.match(prompts.at(-1) ?? '', /Make it terse/);
      const session = await call(app, world.ownerToken, 'GET', `/api/v1/agent-builder/sessions/${sessionId}`);
      assert.equal((session.body.drafts as unknown[]).length, 2);
   });

   test('a plain member cannot apply a draft that adds MCP servers, and nothing is created', async () => {
      const own = await call(app, world.memberToken, 'POST', '/api/v1/agent-builder/sessions');
      const turn = await call(app, world.memberToken, 'POST', `/api/v1/agent-builder/sessions/${own.body.id as string}/turns`, {
         prompt: 'Same again',
      });
      const before = await agentCount();
      const res = await call(app, world.memberToken, 'POST', `/api/v1/agent-builder/sessions/${own.body.id as string}/apply`, {
         draftId: turn.body.draftId,
      });
      assert.equal(res.status, 403);
      assert.equal((res.body.error as { code: string }).code, 'MCP_SETTINGS_REQUIRED');
      assert.equal(await agentCount(), before);
      const [servers] = await sql`SELECT count(*)::int AS n FROM mcp_servers WHERE workspace_id = ${world.workspaceId}`;
      assert.equal(servers?.n, 0);
      const session = await call(app, world.memberToken, 'GET', `/api/v1/agent-builder/sessions/${own.body.id as string}`);
      assert.equal(session.body.status, 'drafting');
   });

   test('applying a draft that is not in the session is not found and leaves the session open', async () => {
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/apply`, {
         draftId: randomUUID(),
      });
      assert.equal(res.status, 404);
      const session = await call(app, world.ownerToken, 'GET', `/api/v1/agent-builder/sessions/${sessionId}`);
      assert.equal(session.body.status, 'drafting');
   });

   test('applying creates the agent with its skill and MCP server, once', async () => {
      const applied = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/apply`, {
         draftId,
      });
      assert.equal(applied.status, 201);
      const agentId = applied.body.agentId as string;
      const [agent] = await sql`SELECT name, instructions FROM agents WHERE id = ${agentId}`;
      assert.equal(agent?.name, 'Release Notes Writer');
      const [bound] = await sql`SELECT count(*)::int AS n FROM agent_skills WHERE agent_id = ${agentId}`;
      assert.equal(bound?.n, 1);
      const [server] = await sql`SELECT name FROM mcp_servers WHERE agent_id = ${agentId}`;
      assert.equal(server?.name, 'changelog');
      const again = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${sessionId}/apply`, {
         draftId,
      });
      assert.equal(again.status, 409);
      assert.equal((again.body.error as { code: string }).code, 'BUILDER_SESSION_CLOSED');
   });

   test('a discarded session takes no more turns', async () => {
      const session = await call(app, world.ownerToken, 'POST', '/api/v1/agent-builder/sessions');
      const id = session.body.id as string;
      assert.equal((await call(app, world.ownerToken, 'DELETE', `/api/v1/agent-builder/sessions/${id}`)).status, 204);
      const turn = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${id}/turns`, {
         prompt: 'Too late',
      });
      assert.equal(turn.status, 409);
   });

   test("a viewer is told 404 for a session that is absent or another workspace's, and 403 only for this one", async () => {
      const viewer = await seedViewer(sql, world);
      const theirs = await call(app, world.outsiderToken, 'POST', '/api/v1/agent-builder/sessions');
      assert.equal(theirs.status, 201);
      try {
         const probes = [
            ['GET', '', undefined],
            ['POST', '/turns', { prompt: 'Anything' }],
            ['POST', '/apply', { draftId: randomUUID() }],
            ['DELETE', '', undefined],
         ] as const;
         for (const [method, suffix, body] of probes) {
            const probe = (id: string) => call(app, viewer.token, method, `/api/v1/agent-builder/sessions/${id}${suffix}`, body);
            assert.equal((await probe(theirs.body.id as string)).status, 404, `${method} ${suffix}: another workspace's`);
            assert.equal((await probe(randomUUID())).status, 404, `${method} ${suffix}: none at all`);
            assert.equal((await probe(sessionId)).status, 403, `${method} ${suffix}: this workspace's`);
         }
      } finally {
         await sql`DELETE FROM agent_builder_sessions WHERE id = ${theirs.body.id as string}`;
         await dropExtraUser(sql, viewer.id);
      }
   });

   test('an outsider cannot read the session', async () => {
      const res = await call(app, world.outsiderToken, 'GET', `/api/v1/agent-builder/sessions/${sessionId}`);
      assert.equal(res.status, 404);
   });
});

describe('agent builder without a runtime', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
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

   test('a turn is refused with a stable code when no completion runtime is wired', async () => {
      const app = buildApp(sql, null);
      const session = await call(app, world.ownerToken, 'POST', '/api/v1/agent-builder/sessions');
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/agent-builder/sessions/${session.body.id as string}/turns`, {
         prompt: 'Anything',
      });
      assert.equal(res.status, 503);
      assert.equal((res.body.error as { code: string }).code, 'AGENT_BUILDER_UNAVAILABLE');
   });
});
