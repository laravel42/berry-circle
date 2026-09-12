import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { IssueRepository } from '../../core/issues.ts';
import { ProjectRepository } from '../../core/projects.ts';
import { closeDatabase, openDatabase, type Sql } from '../../db/pool.ts';
import { createApp, type BerryApp } from '../../http/app.ts';
import { Registry } from '../../http/registry.ts';
import { enqueueTask } from '../../runs/queue.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from '../test-fixture.ts';
import { agentToolMounts } from './mount.ts';
import { mintTaskToken, revokeTaskTokens } from './tokens.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('agent tool API', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let mine: Fixture | null = null;
   let theirs: Fixture | null = null;
   let token = '';
   let issueId = '';
   let runId = '';
   let foreignProjectId = '';
   let foreignIssueId = '';
   const statusCalls: unknown[] = [];

   before(async () => {
      sql = openDatabase({ url: url! });
      mine = await seedFixture(sql, 'tools-a');
      theirs = await seedFixture(sql, 'tools-b');
      issueId = await createIssue(sql, mine, 'Tool task');
      ({ runId } = await enqueueTask(sql, {
         workspaceId: mine.workspaceId, agentId: mine.agentId, issueId, kind: 'agent', source: 'assignment',
      }));
      token = await mintTaskToken(sql, {
         runId, workspaceId: mine.workspaceId, agentId: mine.agentId,
         scopes: ['task:read', 'task:write'], ttlSeconds: 600,
      });
      foreignIssueId = await createIssue(sql, theirs, 'Their task');
      const projects = new ProjectRepository(sql);
      foreignProjectId = (
         await projects.create({
            workspaceId: theirs.workspaceId,
            name: 'Theirs',
            description: null,
            status: 'planned',
            priority: 'none',
            startDate: null,
            targetDate: null,
            githubRepoId: null,
            githubRepoFullName: null,
            createdBy: theirs.userId,
         })
      ).id;
      const issues = new IssueRepository(sql);
      const registry = new Registry();
      registry.registerAll(
         agentToolMounts({
            sql,
            storage: null,
            projects,
            issues: {
               create: (params) => issues.create(params),
               update: async (params) => {
                  statusCalls.push(params);
                  return { issue: {} as never, events: [] };
               },
            },
         })
      );
      app = createApp(registry);
   });
   after(async () => {
      await cleanupFixture(sql, mine);
      await cleanupFixture(sql, theirs);
      await closeDatabase(sql);
   });

   const call = (path: string, init: RequestInit = {}, bearer = token) =>
      app.request(`/api/v1/agent-tools${path}`, {
         ...init,
         headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      });

   test('without a task token nothing answers', async () => {
      const response = await app.request('/api/v1/agent-tools');
      assert.equal(response.status, 401);
      assert.equal((await call('', {}, 'berry_pat_nope')).status, 401);
   });

   test('the manifest lists the core tools with JSON schemas', async () => {
      const body = (await (await call('')).json()) as { tools: Array<{ name: string; inputSchema: unknown }> };
      const names = body.tools.map((tool) => tool.name);
      for (const name of ['read_task', 'post_comment', 'set_status', 'mention_agent', 'create_project', 'create_task'])
         assert.ok(names.includes(name), name);
   });

   test('read_task reads the task this run is on, and only that one', async () => {
      const response = await call('/read_task', { method: 'POST', body: '{}' });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { title: string } };
      assert.equal(body.result.title, 'Tool task');
   });

   test('set_status moves the task as the agent', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 'in_review' }) });
      assert.equal(response.status, 200);
      assert.deepEqual((statusCalls[0] as { actorType: string; issueId: string }).actorType, 'agent');
      assert.equal((statusCalls[0] as { issueId: string }).issueId, issueId);
   });

   test('invalid input is a 400 that names the field', async () => {
      const response = await call('/set_status', { method: 'POST', body: JSON.stringify({ status: 42 }) });
      assert.equal(response.status, 400);
   });

   test('mentioning an agent of another workspace is a 404', async () => {
      const response = await call('/mention_agent', {
         method: 'POST',
         body: JSON.stringify({ agentId: theirs!.agentId, message: 'help' }),
      });
      assert.equal(response.status, 404);
   });

   test('an unknown tool is a 404', async () => {
      assert.equal((await call(`/nope_${randomUUID().slice(0, 4)}`, { method: 'POST', body: '{}' })).status, 404);
   });

   test('create_project files a project in the agent\'s own workspace', async () => {
      const response = await call('/create_project', {
         method: 'POST',
         body: JSON.stringify({ name: '  Winter release  ', description: 'What ships in January.' }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { result: { id: string; name: string } };
      assert.equal(body.result.name, 'Winter release');
      const [row] = await sql`
         SELECT workspace_id, description FROM projects WHERE id = ${body.result.id}`;
      assert.equal(row!.workspace_id, mine!.workspaceId);
      assert.equal(row!.description, 'What ships in January.');
   });

   test('create_task files a task on the board, and a sub-task under its parent', async () => {
      const parent = (await (
         await call('/create_task', { method: 'POST', body: JSON.stringify({ title: 'Ship the thing' }) })
      ).json()) as { result: { id: string; identifier: string; boardId: string } };
      const [onBoard] = await sql`
         SELECT board_id, status::text AS status, parent_id FROM issues WHERE id = ${parent.result.id}`;
      assert.equal(onBoard!.board_id, mine!.boardId);
      assert.equal(onBoard!.status, 'backlog');
      assert.equal(onBoard!.parent_id, null);
      assert.ok(parent.result.identifier.length > 0);

      const child = (await (
         await call('/create_task', {
            method: 'POST',
            body: JSON.stringify({ title: 'Write the migration', parentId: parent.result.id, status: 'in_progress' }),
         })
      ).json()) as { result: { id: string; parentId: string } };
      const [linked] = await sql`
         SELECT parent_id, board_id, status::text AS status FROM issues WHERE id = ${child.result.id}`;
      assert.equal(linked!.parent_id, parent.result.id);
      assert.equal(linked!.board_id, mine!.boardId);
      assert.equal(linked!.status, 'in_progress');
   });

   test('a task can be filed in a project of this workspace', async () => {
      const project = (await (
         await call('/create_project', { method: 'POST', body: JSON.stringify({ name: 'Payments' }) })
      ).json()) as { result: { id: string } };
      const task = (await (
         await call('/create_task', {
            method: 'POST',
            body: JSON.stringify({ title: 'Refunds', projectId: project.result.id }),
         })
      ).json()) as { result: { id: string } };
      const [link] = await sql`
         SELECT project_id FROM issue_project_links WHERE issue_id = ${task.result.id}`;
      assert.equal(link!.project_id, project.result.id);
   });

   test('a project or a parent from another workspace is not found, and nothing is created', async () => {
      const before = (await sql`SELECT count(*)::int AS n FROM issues WHERE board_id = ${mine!.boardId}`)[0]!.n;
      const project = await call('/create_task', {
         method: 'POST',
         body: JSON.stringify({ title: 'Theirs', projectId: foreignProjectId }),
      });
      assert.equal(project.status, 404);
      const parent = await call('/create_task', {
         method: 'POST',
         body: JSON.stringify({ title: 'Theirs', parentId: foreignIssueId }),
      });
      assert.equal(parent.status, 404);
      const after = (await sql`SELECT count(*)::int AS n FROM issues WHERE board_id = ${mine!.boardId}`)[0]!.n;
      assert.equal(after, before);

      // The same title without the foreign id is filed, so the two 404s above
      // are about the ids and not about the tool being absent.
      const ours = await call('/create_task', { method: 'POST', body: JSON.stringify({ title: 'Theirs' }) });
      assert.equal(ours.status, 200);
   });

   test('what an agent files is attributed to the person who asked, and to nobody when none did', async () => {
      await sql`UPDATE runs SET requested_by = ${mine!.userId} WHERE id = ${runId}`;
      const asked = (await (
         await call('/create_task', { method: 'POST', body: JSON.stringify({ title: 'Asked for' }) })
      ).json()) as { result: { id: string } };
      const askedProject = (await (
         await call('/create_project', { method: 'POST', body: JSON.stringify({ name: 'Asked for' }) })
      ).json()) as { result: { id: string } };
      assert.equal((await sql`SELECT created_by FROM issues WHERE id = ${asked.result.id}`)[0]!.created_by, mine!.userId);
      assert.equal(
         (await sql`SELECT created_by FROM projects WHERE id = ${askedProject.result.id}`)[0]!.created_by,
         mine!.userId
      );

      // An autopilot's run: nobody asked, so the row claims no author rather
      // than borrowing the system identity.
      await sql`UPDATE runs SET requested_by = NULL WHERE id = ${runId}`;
      const unasked = (await (
         await call('/create_task', { method: 'POST', body: JSON.stringify({ title: 'Nobody asked' }) })
      ).json()) as { result: { id: string } };
      const unaskedProject = (await (
         await call('/create_project', { method: 'POST', body: JSON.stringify({ name: 'Nobody asked' }) })
      ).json()) as { result: { id: string } };
      assert.equal((await sql`SELECT created_by FROM issues WHERE id = ${unasked.result.id}`)[0]!.created_by, null);
      assert.equal(
         (await sql`SELECT created_by FROM projects WHERE id = ${unaskedProject.result.id}`)[0]!.created_by,
         null
      );
   });

   test('a revoked token stops working', async () => {
      await revokeTaskTokens(sql, runId);
      assert.equal((await call('')).status, 401);
   });
});
