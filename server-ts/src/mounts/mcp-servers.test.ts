import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { McpServerRepository } from '../mcp/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { mcpServerMounts } from './mcp-servers.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('mcp servers mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         mcpServerMounts({
            sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
            sql,
            servers: new McpServerRepository({
               sql,
               sealer: sealerFromKey(randomBytes(32).toString('base64')),
            }),
         })
      );
      app = createApp(registry);
   });

   after(async () => {
      await sql`DELETE FROM mcp_servers WHERE workspace_id IN ${sql([world.workspaceId, world.otherWorkspaceId])}`;
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('an owner adds a server and the response carries header names only', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/mcp-servers', {
         agentId: null,
         name: 'search',
         url: 'https://search.example.test/mcp',
         transport: 'streamable_http',
         headers: { 'X-Api-Key': 'k-123' },
         viaGateway: false,
         enabled: true,
      });
      assert.equal(res.status, 201);
      assert.deepEqual(res.body.headerNames, ['X-Api-Key']);
      assert.equal(JSON.stringify(res.body).includes('k-123'), false);
   });

   test('a plain member may read but not add servers', async () => {
      assert.equal((await call(app, world.memberToken, 'GET', '/api/v1/mcp-servers')).status, 200);
      const res = await call(app, world.memberToken, 'POST', '/api/v1/mcp-servers', {
         agentId: null,
         name: 'nope',
         url: 'https://x.test/mcp',
         transport: 'sse',
         headers: {},
         viaGateway: false,
         enabled: true,
      });
      assert.equal(res.status, 403);
   });

   test('a server for another workspace’s agent is not found', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/mcp-servers', {
         agentId: world.otherAgentId,
         name: 'cross',
         url: 'https://x.test/mcp',
         transport: 'sse',
         headers: {},
         viaGateway: false,
         enabled: true,
      });
      assert.equal(res.status, 404);
   });

   test('an outsider lists nothing', async () => {
      const res = await call(app, world.outsiderToken, 'GET', '/api/v1/mcp-servers');
      assert.deepEqual(res.body.nodes, []);
   });
});
