import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { SkillRepository } from '../skills/repository.ts';
import { SquadRepository } from '../squads/repository.ts';
import { loadAgentExtensions, skillManifest } from './extensions.ts';
import { AgentProfileRepository } from './profile.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

test('a manifest quotes the description so a colon cannot break the frontmatter', () => {
   assert.equal(
      skillManifest({ name: 'x', description: 'a: b', content: 'body' }),
      '---\nname: x\ndescription: "a: b"\n---\nbody'
   );
});

describe('agent extensions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let skills: SkillRepository;
   let mcp: McpServerRepository;
   let profile: AgentProfileRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const sealer = sealerFromKey(randomBytes(32).toString('base64'));
      skills = new SkillRepository(sql);
      mcp = new McpServerRepository({ sql, sealer });
      profile = new AgentProfileRepository({ sql, sealer });
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an agent carries enabled skills, its MCP servers, opened env and its squad briefing', async () => {
      const skill = await skills.create(
         world.workspaceId,
         {
            name: 'ext-skill',
            description: 'd',
            content: 'c',
            labels: [],
            files: [{ path: 'scripts/run.sh', content: 'echo hi' }],
         },
         world.ownerId
      );
      await skills.setBinding(world.workspaceId, world.agentId, skill.id, true);
      const off = await skills.create(
         world.workspaceId,
         { name: 'off-skill', description: '', content: '', labels: [], files: [] },
         world.ownerId
      );
      await skills.setBinding(world.workspaceId, world.agentId, off.id, false);
      await mcp.create(
         world.workspaceId,
         {
            agentId: null,
            name: 'direct',
            url: 'https://d.test/mcp',
            transport: 'streamable_http',
            headers: { K: 'v' },
            viaGateway: false,
            enabled: true,
         },
         world.ownerId
      );
      await mcp.create(
         world.workspaceId,
         {
            agentId: null,
            name: 'gated',
            url: 'https://g.test/mcp',
            transport: 'streamable_http',
            headers: {},
            viaGateway: true,
            enabled: true,
         },
         world.ownerId
      );
      await profile.setEnv(world.workspaceId, world.agentId, { TOKEN: 't' });

      const withoutGateway = await loadAgentExtensions(
         { sql, skills, mcp, profile, gateway: null },
         { workspaceId: world.workspaceId, agentId: world.agentId, issueId: world.issueId }
      );
      assert.deepEqual(
         withoutGateway.skills.map((s) => s.name),
         ['ext-skill']
      );
      assert.deepEqual(
         withoutGateway.skills[0]?.files.map((f) => f.path),
         ['SKILL.md', 'scripts/run.sh']
      );
      assert.match(withoutGateway.skills[0]?.files[0]?.content ?? '', /^---\nname: ext-skill\n/);
      assert.deepEqual(
         withoutGateway.mcpServers.map((s) => s.name),
         ['direct']
      );
      assert.equal(withoutGateway.mcpServers[0]?.transport, 'streamable_http');
      assert.deepEqual(withoutGateway.mcpServers[0]?.headers, { K: 'v' });
      assert.deepEqual(withoutGateway.skipped, ['gated']);
      assert.deepEqual(withoutGateway.env, { TOKEN: 't' });
      assert.equal(withoutGateway.squadBriefing, null);

      const withGateway = await loadAgentExtensions(
         {
            sql,
            skills,
            mcp,
            profile,
            gateway: { url: 'https://gw.test/mcp', headers: async () => ({ authorization: 'Bearer gw' }) },
         },
         { workspaceId: world.workspaceId, agentId: world.agentId, issueId: null }
      );
      assert.deepEqual(
         withGateway.mcpServers.find((s) => s.name === 'gated'),
         {
            name: 'gated',
            url: 'https://gw.test/mcp',
            transport: 'streamable_http',
            headers: { authorization: 'Bearer gw' },
            allowedTools: null,
         }
      );
      assert.deepEqual(withGateway.skipped, []);
      assert.equal(withGateway.squadBriefing, null);
   });

   test('the leader of a squad issue carries the briefing; a member does not', async () => {
      const squads = new SquadRepository(sql);
      const [member] = await sql`
         INSERT INTO agents (workspace_id, name, status) VALUES (${world.workspaceId}, 'Helper', 'available')
         RETURNING id`;
      const squad = await squads.create(
         world.workspaceId,
         { name: 'Crew', description: '', leaderAgentId: world.agentId },
         world.ownerId
      );
      await squads.setMembers(world.workspaceId, squad.id, [{ type: 'agent', id: member?.id as string, role: 'helper' }]);
      await squads.recordAssignment(world.workspaceId, squad.id, world.issueId, world.ownerId);
      const leader = await loadAgentExtensions(
         { sql, skills, mcp, profile, gateway: null },
         { workspaceId: world.workspaceId, agentId: world.agentId, issueId: world.issueId }
      );
      assert.match(leader.squadBriefing ?? '', /You lead the squad "Crew"/);
      const helper = await loadAgentExtensions(
         { sql, skills, mcp, profile, gateway: null },
         { workspaceId: world.workspaceId, agentId: member?.id as string, issueId: world.issueId }
      );
      assert.equal(helper.squadBriefing, null);
   });

   test('another workspace’s id yields nothing of this agent', async () => {
      const foreign = await loadAgentExtensions(
         { sql, skills, mcp, profile, gateway: null },
         { workspaceId: world.otherWorkspaceId, agentId: world.agentId, issueId: null }
      ).catch(() => null);
      assert.ok(foreign === null || (foreign.skills.length === 0 && foreign.mcpServers.length === 0));
   });
});
