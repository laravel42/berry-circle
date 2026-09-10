import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupFixture, createIssue, seedFixture, type Fixture } from './test-fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('migration 053', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let fixture: Fixture | null = null;

   before(async () => {
      sql = openDatabase({ url: url! });
      fixture = await seedFixture(sql, 'schema');
   });
   after(async () => {
      await cleanupFixture(sql, fixture);
      await closeDatabase(sql);
   });

   test('a completion task needs no issue, and its workspace is filled in', async () => {
      const f = fixture!;
      const id = randomUUID();
      await sql`
         INSERT INTO runs (id, workspace_id, agent_id, kind, source, prompt)
         VALUES (${id}, ${f.workspaceId}, ${f.orchestratorId}, 'completion', 'completion', 'hi')`;
      const [row] = await sql`SELECT issue_id, board_id, workspace_id, priority FROM runs WHERE id = ${id}`;
      assert.equal(row!.issue_id, null);
      assert.equal(row!.workspace_id, f.workspaceId);
      assert.equal(row!.priority, 0);
   });

   test('an issue run gets its workspace from its board', async () => {
      const f = fixture!;
      const issueId = await createIssue(sql, f);
      const id = randomUUID();
      await sql`
         INSERT INTO runs (id, issue_id, board_id, agent_id)
         VALUES (${id}, ${issueId}, ${f.boardId}, ${f.agentId})`;
      const [row] = await sql`SELECT workspace_id, kind, source FROM runs WHERE id = ${id}`;
      assert.deepEqual({ ...row }, { workspace_id: f.workspaceId, kind: 'agent', source: 'assignment' });
   });

   test('an agent task with neither issue nor chat is refused', async () => {
      const f = fixture!;
      await assert.rejects(
         sql`INSERT INTO runs (id, workspace_id, agent_id, kind, source)
             VALUES (${randomUUID()}, ${f.workspaceId}, ${f.agentId}, 'agent', 'mention')`,
         /runs_task_target_ck/
      );
   });

   test('a runtime idle timeout above eight hours is refused', async () => {
      const f = fixture!;
      await assert.rejects(
         // A valid ARN, so the only constraint this row can break is the idle timeout.
         sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, arn, idle_timeout_s)
             VALUES (${f.workspaceId}, 'too long', 'custom', 'agentcore',
                     'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/too-long', 28801)`,
         /agent_runtimes_idle_timeout_ck/
      );
   });

   test('a workspace has at most one default runtime', async () => {
      const f = fixture!;
      // Valid targets, so the only constraint the second row can break is the default.
      await sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, is_default)
                VALUES (${f.workspaceId}, 'one', 'custom', 'http', 'http://one:8080', true)`;
      await assert.rejects(
         sql`INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url, is_default)
             VALUES (${f.workspaceId}, 'two', 'custom', 'http', 'http://two:8080', true)`,
         /agent_runtimes_one_default_key/
      );
   });
});
