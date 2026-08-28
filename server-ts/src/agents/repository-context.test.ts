import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { openDatabase, closeDatabase, type Sql } from '../db/pool.ts';
import { repositoryForIssue } from './repository-context.ts';

/**
 * Which repository a run's work belongs in.
 *
 * Database-backed, because the answer is a join across three tables and the
 * ordering rule — oldest link wins — is the kind of thing a fake would agree
 * with regardless of whether the SQL says it.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('repository for an issue', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   const fixture: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url! });
      const suffix = randomUUID().slice(0, 8);
      const [user] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`repo-${suffix}@berry.test`}, 'Repo Test') RETURNING id`;
      fixture.userId = user!.id as string;

      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`Repo ${suffix}`}, ${`repo-${suffix}`},
                 ${sql.json({ issuePrefix: 'REP', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${fixture.userId})
         RETURNING id`;
      fixture.workspaceId = workspace!.id as string;
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${fixture.workspaceId}, ${fixture.userId}, 'owner')`;

      const [board] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug, created_by)
         VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Repo board', ${`rep-${suffix}`}, ${fixture.userId})
         RETURNING id`;
      fixture.boardId = board!.id as string;
   });

   after(async () => {
      if (!sql) return;
      await sql`DELETE FROM issue_project_links WHERE workspace_id = ${fixture.workspaceId!}`;
      await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
      await sql`DELETE FROM projects WHERE workspace_id = ${fixture.workspaceId!}`;
      await sql`DELETE FROM boards WHERE id = ${fixture.boardId!}`;
      await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId!}`;
      await sql`UPDATE users SET last_workspace_id = NULL WHERE id = ${fixture.userId!}`;
      await closeDatabase(sql);
   });

   async function newIssue(): Promise<string> {
      const id = randomUUID();
      const [counter] = await sql`
         UPDATE boards SET issue_counter = issue_counter + 1
          WHERE id = ${fixture.boardId!} RETURNING issue_counter`;
      await sql`
         INSERT INTO issues (id, board_id, number, title, created_by)
         VALUES (${id}, ${fixture.boardId!}, ${Number(counter!.issue_counter)}, 'Task', ${fixture.userId!})`;
      return id;
   }

   /** `github_repo_id` is a bigint, and a constraint keeps it with the name. */
   let nextRepoId = 1000;
   async function newProject(repo: string | null): Promise<string> {
      const id = randomUUID();
      await sql`
         INSERT INTO projects (id, workspace_id, name, github_repo_full_name, github_repo_id, created_by)
         VALUES (${id}, ${fixture.workspaceId!}, ${`Project ${id.slice(0, 4)}`},
                 ${repo}, ${repo ? (nextRepoId += 1) : null}, ${fixture.userId!})`;
      return id;
   }

   async function link(issueId: string, projectId: string, at: string): Promise<void> {
      await sql`
         INSERT INTO issue_project_links (workspace_id, issue_id, project_id, linked_by, created_at)
         VALUES (${fixture.workspaceId!}, ${issueId}, ${projectId}, ${fixture.userId!}, ${at})`;
   }

   test('a task in no project has no repository, which is not an error', async () => {
      // Plenty of work is answering a question. A run without code to change
      // proceeds without a checkout.
      assert.equal(await repositoryForIssue(sql, await newIssue()), null);
   });

   test('a task whose project names no repository has none either', async () => {
      const issueId = await newIssue();
      await link(issueId, await newProject(null), '2026-01-01T00:00:00Z');
      assert.equal(await repositoryForIssue(sql, issueId), null);
   });

   test('a task in a project with a repository finds it', async () => {
      const issueId = await newIssue();
      await link(issueId, await newProject('berry/frontend'), '2026-01-01T00:00:00Z');

      const found = await repositoryForIssue(sql, issueId);
      assert.equal(found?.fullName, 'berry/frontend');
      assert.match(found!.projectName, /^Project /);
   });

   test('the database will not let a task belong to two projects', async () => {
      // Worth asserting rather than assuming: the lookup reads as though it
      // might be choosing between several, and the reason it is not is this
      // constraint. If it were ever relaxed, the lookup would need a rule.
      const issueId = await newIssue();
      await link(issueId, await newProject('berry/first'), '2026-01-01T00:00:00Z');
      await assert.rejects(
         link(issueId, await newProject('berry/second'), '2026-06-01T00:00:00Z'),
         /duplicate key|issue_project_links_pkey/
      );
      assert.equal((await repositoryForIssue(sql, issueId))?.fullName, 'berry/first');
   });
});
