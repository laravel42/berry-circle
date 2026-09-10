import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { AgentBuilder } from '../agents/builder.ts';
import { AgentProfileRepository } from '../agents/profile.ts';
import { AgentRepository } from '../agents/repository.ts';
import { agentAccessGuard } from '../agents/access.ts';
import type { CompleteFn, CompletionRequest, EnqueueTask } from '../agents/seams.ts';
import { commentTriggers } from '../agents/triggers.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { ConversationRepository } from '../conversations/repository.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { RunLedger } from '../runs/ledger.ts';
import { RunRepository } from '../runs/repository.ts';
import { SkillRepository } from '../skills/repository.ts';
import { SquadRepository } from '../squads/repository.ts';
import { agentBuilderMounts } from './agent-builder.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { agentMounts } from './agents.ts';
import { issueCommentRoutes } from './comments.ts';
import { conversationMounts } from './conversations.ts';
import { issueMounts } from './issues.ts';
import { mcpServerMounts } from './mcp-servers.ts';
import { skillMounts } from './skills.ts';
import { squadMounts } from './squads.ts';

/**
 * Tenant isolation for every agent-layer mount.
 *
 * The owner of workspace W creates one of each resource; the outsider, who
 * owns only W2, then probes every route. Each probe must answer 404, never 200
 * or 403 (a 403 reveals that the resource exists), and W must be unchanged.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent layer tenant isolation', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;
   const ids = { skill: '', mcp: '', squad: '', builder: '', conversation: '' };

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const idempotency = new IdempotencyStore(sql);
      const sealer = sealerFromKey(randomBytes(32).toString('base64'));
      const skills = new SkillRepository(sql);
      const mcp = new McpServerRepository({ sql, sealer });
      const agents = new AgentRepository(sql);
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const complete: CompleteFn = async <T>(request: CompletionRequest<T>): Promise<T> =>
         request.schema.parse({ name: 'Probe', description: '', instructions: '' });
      const enqueue: EnqueueTask = async () => {
         throw new Error('no task may be queued by a cross-tenant probe');
      };
      const registry = new Registry();
      registry.registerAll(skillMounts({ sessions, sql, skills, idempotency }));
      registry.registerAll(mcpServerMounts({ sessions, sql, servers: mcp }));
      registry.registerAll(
         squadMounts({
            sessions,
            sql,
            squads: new SquadRepository(sql),
            issues,
            enqueue,
            agentAccess: agentAccessGuard(sql),
         })
      );
      registry.registerAll(
         agentBuilderMounts({ sessions, sql, builder: new AgentBuilder({ sql, complete, skills, agents, mcp }) })
      );
      registry.registerAll(
         conversationMounts({
            sessions,
            conversations: new ConversationRepository(sql),
            boards,
            sql,
            enqueue,
            complete: null,
            ledger: new RunLedger({ sql }),
            runs: new RunRepository(sql),
         })
      );
      registry.registerAll(
         agentMounts({
            sessions,
            agents,
            idempotency,
            catalog: null,
            runs: new RunRepository(sql),
            ledger: new RunLedger({ sql }),
            profile: new AgentProfileRepository({ sql, sealer }),
         })
      );
      registry.registerAll(
         issueMounts({
            sessions,
            issues,
            boards,
            idempotency,
            agentAccess: agentAccessGuard(sql),
            nested: issueCommentRoutes({
               sessions,
               comments: new CommentRepository(sql),
               issues,
               idempotency,
               triggers: commentTriggers({ sql, enqueue, report: () => undefined }),
            }),
         })
      );
      app = createApp(registry);

      const own = (method: string, path: string, body?: unknown) => call(app, world.ownerToken, method, path, body);
      ids.skill = (await own('POST', '/api/v1/skills', { name: 'ct-skill' })).body.id as string;
      ids.mcp = (
         await own('POST', '/api/v1/mcp-servers', {
            agentId: null,
            name: 'ct-mcp',
            url: 'https://ct.test/mcp',
            headers: {},
         })
      ).body.id as string;
      ids.squad = (await own('POST', '/api/v1/squads', { name: 'CT', leaderAgentId: world.agentId })).body.id as string;
      ids.builder = (await own('POST', '/api/v1/agent-builder/sessions')).body.id as string;
      ids.conversation = (await own('POST', '/api/v1/conversations', { agentId: world.agentId })).body.id as string;
      for (const [name, id] of Object.entries(ids)) assert.match(id, /^[0-9a-f-]{36}$/, name);
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   const probes = (): [string, string, unknown?][] => [
      ['GET', `/api/v1/skills/${ids.skill}`],
      ['PATCH', `/api/v1/skills/${ids.skill}`, { description: 'x' }],
      ['DELETE', `/api/v1/skills/${ids.skill}`],
      ['POST', `/api/v1/skills/${ids.skill}/refresh`],
      ['PUT', `/api/v1/skills/${ids.skill}/agents/${world.agentId}`, { enabled: true }],
      ['PATCH', `/api/v1/mcp-servers/${ids.mcp}`, { enabled: false }],
      ['DELETE', `/api/v1/mcp-servers/${ids.mcp}`],
      ['GET', `/api/v1/squads/${ids.squad}`],
      ['PUT', `/api/v1/squads/${ids.squad}/members`, { members: [] }],
      ['POST', `/api/v1/squads/${ids.squad}/assign`, { issueRef: world.issueId }],
      ['GET', `/api/v1/agent-builder/sessions/${ids.builder}`],
      ['POST', `/api/v1/agent-builder/sessions/${ids.builder}/turns`, { prompt: 'x' }],
      ['GET', `/api/v1/conversations/${ids.conversation}/messages`],
      ['POST', `/api/v1/conversations/${ids.conversation}/messages`, { body: 'x' }],
      ['PUT', `/api/v1/conversations/${ids.conversation}/draft`, { draft: 'x' }],
      ['GET', `/api/v1/conversations/${ids.conversation}/tasks`],
      ['POST', `/api/v1/issues/${world.issueId}/comments/trigger-preview`, { body: 'x' }],
      ['GET', `/api/v1/agents/${world.agentId}/access`],
      ['GET', `/api/v1/agents/${world.agentId}/tasks`],
      ['PUT', `/api/v1/agents/${world.agentId}/env`, { env: { A: 'b' } }],
      ['PUT', `/api/v1/agents/${world.agentId}/labels`, { labels: ['x'] }],
      [
         'PUT',
         `/api/v1/agents/${world.agentId}/permissions`,
         { access: { assign: 'everyone', mention: 'everyone', members: [] } },
      ],
      ['POST', `/api/v1/agents/${world.agentId}/copy`],
      ['POST', `/api/v1/agents/${world.agentId}/restore`],
      ['POST', `/api/v1/agents/${world.agentId}/cancel-tasks`],
      ['GET', `/api/v1/agents/${world.agentId}/avatar`],
      ['PUT', `/api/v1/agents/${world.agentId}/avatar`],
      ['DELETE', `/api/v1/agents/${world.agentId}`],
      ['DELETE', `/api/v1/skills/${ids.skill}/agents/${world.agentId}`],
      ['PATCH', `/api/v1/squads/${ids.squad}`, { name: 'x' }],
      ['DELETE', `/api/v1/squads/${ids.squad}`],
      ['DELETE', `/api/v1/agent-builder/sessions/${ids.builder}`],
      ['PATCH', `/api/v1/conversations/${ids.conversation}`, { title: 'x' }],
      ['DELETE', `/api/v1/conversations/${ids.conversation}`],
      ['POST', `/api/v1/conversations/${ids.conversation}/read`],
      // Creates in the caller's own workspace that name a W agent: each must be refused, not cross-linked.
      ['POST', '/api/v1/conversations', { agentId: world.agentId }],
      ['PUT', '/api/v1/conversations/pinned-agents', { agentIds: [world.agentId] }],
      ['POST', '/api/v1/mcp-servers', { agentId: world.agentId, name: 'ct-x', url: 'https://x.test/mcp' }],
      ['POST', '/api/v1/squads', { name: 'CTX', leaderAgentId: world.agentId }],
   ];

   test('every agent-layer resource of W answers 404 to a caller from W2, and W is unchanged', async () => {
      for (const [method, path, body] of probes()) {
         const res = await call(app, world.outsiderToken, method, path, body);
         assert.equal(res.status, 404, `${method} ${path}`);
      }
      const [skill] = await sql`SELECT description FROM skills WHERE id = ${ids.skill}`;
      assert.notEqual(skill?.description, 'x');
      const [mcp] = await sql`SELECT enabled FROM mcp_servers WHERE id = ${ids.mcp}`;
      assert.equal(mcp?.enabled, true);
      const [squad] = await sql`SELECT archived_at, name FROM squads WHERE id = ${ids.squad}`;
      assert.equal(squad?.archived_at, null);
      assert.equal(squad?.name, 'CT');
      const [builder] = await sql`SELECT status FROM agent_builder_sessions WHERE id = ${ids.builder}`;
      assert.equal(builder?.status, 'drafting');
      const [conversation] = await sql`SELECT id FROM conversations WHERE id = ${ids.conversation}`;
      assert.ok(conversation);
      const [draft] = await sql`
         SELECT count(*)::int AS n FROM conversation_messages WHERE conversation_id = ${ids.conversation}`;
      assert.equal(draft?.n, 0);
      const [agent] = await sql`SELECT archived_at, labels, env_names FROM agents WHERE id = ${world.agentId}`;
      assert.equal(agent?.archived_at, null);
      assert.deepEqual(agent?.labels, []);
      assert.deepEqual(agent?.env_names, []);
      const [crossLinked] = await sql`
         SELECT (SELECT count(*) FROM mcp_servers WHERE agent_id = ${world.agentId} AND workspace_id = ${world.otherWorkspaceId})
              + (SELECT count(*) FROM squads WHERE leader_agent_id = ${world.agentId} AND workspace_id = ${world.otherWorkspaceId})
              + (SELECT count(*) FROM user_pinned_agents WHERE agent_id = ${world.agentId} AND user_id = ${world.outsiderId})
              + (SELECT count(*) FROM agents WHERE workspace_id = ${world.otherWorkspaceId} AND name LIKE '%(copy)')
              AS n`;
      assert.equal(Number(crossLinked?.n), 0);
   });

   test('W2’s listings contain nothing of W', async () => {
      for (const path of ['/api/v1/skills', '/api/v1/mcp-servers', '/api/v1/squads', '/api/v1/conversations']) {
         const res = await call(app, world.outsiderToken, 'GET', path);
         assert.equal(res.status, 200, path);
         assert.deepEqual(res.body.nodes, [], path);
      }
   });

   test('an unauthenticated caller is refused before any handler', async () => {
      for (const path of [
         '/api/v1/skills',
         '/api/v1/mcp-servers',
         '/api/v1/squads',
         '/api/v1/agent-builder/sessions',
         '/api/v1/conversations',
      ]) {
         const res = await app.request(path);
         assert.equal(res.status, 401, path);
      }
   });
});
