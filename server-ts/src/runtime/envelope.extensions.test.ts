import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { nullRunMemory } from '../agentcore/memory.ts';
import type { EnvelopeMcpServer, EnvelopeSkill } from '../agents/extensions.ts';
import { AgentProfileRepository } from '../agents/profile.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { GitHubClient } from '../integrations/github.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { enqueueTask } from '../runs/queue.ts';
import { SkillRepository } from '../skills/repository.ts';
import { taskEnvelopeSchema, type McpServerRef, type SkillRef } from './envelope.ts';
import { EnvelopeBuilder, loadTask } from './envelope-builder.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';

// The agent layer's shapes are the runtime's, not a mapping: tsc refuses a drift.
const skillRef: SkillRef = {} as EnvelopeSkill;
const mcpRef: McpServerRef = {} as EnvelopeMcpServer;
void skillRef;
void mcpRef;

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('the envelope carries the agent’s extensions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;
   let builder: EnvelopeBuilder;
   const skipped: string[][] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'extensions');
      const sealer = sealerFromKey(randomBytes(32).toString('base64'));
      const skills = new SkillRepository(sql);
      const mcp = new McpServerRepository({ sql, sealer });
      builder = new EnvelopeBuilder({
         sql,
         publicUrl: 'https://berry.test',
         defaultModel: 'default-model',
         memory: nullRunMemory(),
         sealer: null,
         github: (token) => new GitHubClient({ token }),
         extensions: { skills, mcp, profile: new AgentProfileRepository({ sql, sealer }), gateway: null },
         onSkipped: (names) => skipped.push(names),
      });
      const f = fixture;
      const skill = await skills.create(
         f.workspaceId,
         { name: 'ext-skill', description: 'd', content: 'c', labels: [], files: [] },
         f.userId
      );
      await skills.setBinding(f.workspaceId, f.agentId, skill.id, true);
      const server = {
         agentId: null,
         transport: 'streamable_http' as const,
         headers: { K: 'secret-header' },
         enabled: true,
      };
      await mcp.create(f.workspaceId, { ...server, name: 'direct', url: 'https://d.test/mcp', viaGateway: false }, f.userId);
      await mcp.create(f.workspaceId, { ...server, name: 'gated', url: 'https://g.test/mcp', viaGateway: true }, f.userId);
   });
   after(async () => {
      await sql`DELETE FROM runs WHERE workspace_id = ${fixture!.workspaceId}`;
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('an agent task carries its enabled skills and MCP servers', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f, 'Extensions task');
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.agentId, issueId, kind: 'agent', source: 'mention', prompt: 'go',
      });
      const { envelope: built } = await builder.build({ task: await loadTask(sql, runId), dispatch: null, token: 'berry_task_x' });
      const envelope = taskEnvelopeSchema.parse(built);
      assert.deepEqual(envelope.agent.skills.map((s) => s.name), ['ext-skill']);
      // SKILL.md survives the parse: the schema keeps only name and files.
      assert.ok(envelope.agent.skills[0]?.files.some((file) => file.path === 'SKILL.md'));
      assert.deepEqual(envelope.agent.mcpServers.map((s) => [s.name, s.transport]), [['direct', 'streamable_http']]);
      // A gateway-routed server with no gateway is left out, and said so by name.
      assert.deepEqual(skipped.at(-1), ['gated']);
   });

   test('a completion carries none of them', async () => {
      const f = fixture!;
      const { runId } = await enqueueTask(sql, {
         workspaceId: f.workspaceId, agentId: f.orchestratorId, kind: 'completion', source: 'completion', prompt: 'p',
      });
      const { envelope } = await builder.build({ task: await loadTask(sql, runId), dispatch: null, token: 'berry_task_x' });
      assert.deepEqual(envelope.agent.skills, []);
      assert.deepEqual(envelope.agent.mcpServers, []);
   });
});
