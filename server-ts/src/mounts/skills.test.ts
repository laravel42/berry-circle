import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SkillRepository } from '../skills/repository.ts';
import { call, dropAgentLayerWorld, seedAgentLayerWorld, type AgentLayerWorld } from './agent-layer.fixture.ts';
import { skillMounts } from './skills.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('skills mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: AgentLayerWorld;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedAgentLayerWorld(sql);
      const registry = new Registry();
      registry.registerAll(
         skillMounts({
            sessions: new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] }),
            sql,
            skills: new SkillRepository(sql),
            importer: {
               fromGitHub: async (u) => ({
                  name: 'imported-skill',
                  description: 'd',
                  content: 'c',
                  labels: [],
                  files: [],
                  sourceKind: 'github',
                  sourceUrl: u,
                  sourceRef: 'main',
               }),
            },
         })
      );
      app = createApp(registry);
   });

   after(async () => {
      await dropAgentLayerWorld(sql, world);
      await closeDatabase(sql);
   });

   test('a skill is created with its files and found by search', async () => {
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'pdf-tools',
         description: 'Work with PDF files',
         content: 'Use pdftotext.',
         labels: ['docs'],
         files: [{ path: 'scripts/extract.sh', content: 'pdftotext "$1"' }],
      });
      assert.equal(created.status, 201);
      assert.deepEqual(created.body.files, [{ path: 'scripts/extract.sh', size: 14 }]);

      const found = await call(app, world.ownerToken, 'GET', '/api/v1/skills?q=PDF');
      const names = (found.body.nodes as { name: string }[]).map((n) => n.name);
      assert.deepEqual(names, ['pdf-tools']);
   });

   test('a duplicate name is a conflict, and a bad name is a validation error', async () => {
      const dup = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'pdf-tools', description: '', content: '', labels: [], files: [],
      });
      assert.equal(dup.status, 409);
      assert.equal((dup.body.error as { code: string }).code, 'SKILL_NAME_TAKEN');
      const bad = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'PDF Tools', description: '', content: '', labels: [], files: [],
      });
      // assertValid throws ValidationFailed: 422 VALIDATION_FAILED (http/body.ts).
      assert.equal(bad.status, 422);
      assert.equal((bad.body.error as { code: string }).code, 'VALIDATION_FAILED');
   });

   test('a file path that climbs out of the skill is refused', async () => {
      const res = await call(app, world.ownerToken, 'POST', '/api/v1/skills', {
         name: 'escape', description: '', content: '', labels: [],
         files: [{ path: '../etc/passwd', content: 'x' }],
      });
      assert.equal(res.status, 422);
   });

   test('a member may read skills, and an outsider’s write to one is 404', async () => {
      assert.equal((await call(app, world.memberToken, 'GET', '/api/v1/skills')).status, 200);
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.outsiderToken, 'PATCH', `/api/v1/skills/${skillId}`, { description: 'x' });
      assert.equal(res.status, 404);
   });

   test('binding a skill to an agent shows up when listing for that agent', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const bound = await call(app, world.ownerToken, 'PUT', `/api/v1/skills/${skillId}/agents/${world.agentId}`, {
         enabled: true,
      });
      assert.equal(bound.status, 204);
      const forAgent = await call(app, world.ownerToken, 'GET', `/api/v1/skills?agentId=${world.agentId}`);
      assert.equal((forAgent.body.nodes as { agentEnabled: boolean }[])[0]?.agentEnabled, true);
   });

   test('binding to an agent of another workspace is not found', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills');
      const skillId = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.ownerToken, 'PUT', `/api/v1/skills/${skillId}/agents/${world.otherAgentId}`, {
         enabled: true,
      });
      assert.equal(res.status, 404);
   });

   test('an outsider sees none of this workspace’s skills', async () => {
      const res = await call(app, world.outsiderToken, 'GET', '/api/v1/skills');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.nodes, []);
   });

   test('a GitHub import creates a refreshable skill', async () => {
      const created = await call(app, world.ownerToken, 'POST', '/api/v1/skills/import', {
         url: 'https://github.com/acme/skills/tree/main/imported',
      });
      assert.equal(created.status, 201);
      assert.equal((created.body.source as { kind: string }).kind, 'github');
      const refreshed = await call(app, world.ownerToken, 'POST', `/api/v1/skills/${created.body.id as string}/refresh`);
      assert.equal(refreshed.status, 200);
   });

   test('a manual skill cannot be refreshed', async () => {
      const list = await call(app, world.ownerToken, 'GET', '/api/v1/skills?q=pdf-tools');
      const id = (list.body.nodes as { id: string }[])[0]?.id as string;
      const res = await call(app, world.ownerToken, 'POST', `/api/v1/skills/${id}/refresh`);
      assert.equal(res.status, 409);
   });
});
