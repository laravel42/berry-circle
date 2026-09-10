import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from '../mounts/agent-layer.fixture.ts';
import { McpServerRepository } from './repository.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('mcp servers', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: AgentLayerWorld;
   let repo: McpServerRepository;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      repo = new McpServerRepository({ sql, sealer: sealerFromKey(randomBytes(32).toString('base64')) });
   });
   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('headers are sealed at rest and only their names are listed', async () => {
      const created = await repo.create(world.workspaceId, {
         agentId: null, name: 'docs', url: 'https://mcp.example.test/mcp', transport: 'streamable_http',
         headers: { Authorization: 'Bearer secret-token' }, viaGateway: false, enabled: true,
      }, world.ownerId);
      assert.deepEqual(created.headerNames, ['Authorization']);
      assert.equal(JSON.stringify(created).includes('secret-token'), false);
      const [raw] = await sql`SELECT headers_sealed FROM mcp_servers WHERE id = ${created.id}`;
      assert.equal(Buffer.from(raw?.headers_sealed as Buffer).toString('utf8').includes('secret-token'), false);
   });

   test('an agent gets workspace servers plus its own, enabled only, with headers opened', async () => {
      await repo.create(world.workspaceId, {
         agentId: world.agentId, name: 'own', url: 'https://own.example.test/mcp', transport: 'sse',
         headers: {}, viaGateway: false, enabled: true,
      }, world.ownerId);
      await repo.create(world.workspaceId, {
         agentId: null, name: 'off', url: 'https://off.example.test/mcp', transport: 'streamable_http',
         headers: {}, viaGateway: false, enabled: false,
      }, world.ownerId);
      const servers = await repo.forAgent(world.workspaceId, world.agentId);
      assert.deepEqual(servers.map((s) => s.name).sort(), ['docs', 'own']);
      assert.equal(servers.find((s) => s.name === 'docs')?.headers.Authorization, 'Bearer secret-token');
   });
});
