import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { list } from './migrations.ts';

/**
 * Migration 183: every workspace has a board.
 *
 * `issues.board_id` is NOT NULL, so a boardless workspace can hold no task at
 * all. The guarantee is asserted from both ends — the trigger for a new
 * workspace and the backfill for an existing one — and the migration is run
 * twice, because a backfill that ran again on a workspace it had already
 * served would give it a second board.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('the default board migration', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let migration = '';
   const workspaceIds: string[] = [];

   async function createWorkspace(label: string): Promise<string> {
      const suffix = randomUUID().slice(0, 8);
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings)
         VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
                 ${sql.json({ issuePrefix: 'BRD', defaultRole: 'member', allowMemberInvites: false } as never)})
         RETURNING id`;
      const workspaceId = workspace!.id as string;
      workspaceIds.push(workspaceId);
      return workspaceId;
   }

   const boardsOf = (workspaceId: string) =>
      sql`SELECT id, name, slug, created_by FROM boards WHERE workspace_id = ${workspaceId} ORDER BY created_at`;

   before(async () => {
      sql = openDatabase({ url: url! });
      const found = (await list()).find((entry) => entry.version === 183);
      assert.ok(found, 'migration 183 is not on disk');
      migration = found.sql;
   });

   after(async () => {
      await sql`DELETE FROM boards WHERE workspace_id IN ${sql(workspaceIds)}`;
      await deleteWorkspaceAgents(sql, workspaceIds);
      await sql`DELETE FROM workspaces WHERE id IN ${sql(workspaceIds)}`;
      await closeDatabase(sql);
   });

   test('a new workspace is given exactly one board', async () => {
      const workspaceId = await createWorkspace('board-new');
      const boards = await boardsOf(workspaceId);
      assert.equal(boards.length, 1);
      assert.equal(boards[0]!.name, 'Tasks');
      // A trigger has no actor, so the board claims no author.
      assert.equal(boards[0]!.created_by, null);
      // The slug is unique deployment-wide, so it cannot always be 'tasks'.
      assert.match(boards[0]!.slug as string, /^tasks(-[0-9a-f]{6})?$/);
   });

   test('an existing boardless workspace gains one when the migration runs', async () => {
      const workspaceId = await createWorkspace('board-backfill');
      await sql`DELETE FROM boards WHERE workspace_id = ${workspaceId}`;
      assert.equal((await boardsOf(workspaceId)).length, 0);

      await sql.unsafe(migration);
      const boards = await boardsOf(workspaceId);
      assert.equal(boards.length, 1);
      assert.equal(boards[0]!.name, 'Tasks');
   });

   test('a workspace that already has a board gains nothing', async () => {
      // A board of the workspace's own, and no default one: what a workspace
      // that named its board itself looks like.
      const workspaceId = await createWorkspace('board-kept');
      await sql`DELETE FROM boards WHERE workspace_id = ${workspaceId}`;
      const [mine] = await sql`
         INSERT INTO boards (id, workspace_id, name, slug)
         VALUES (${randomUUID()}, ${workspaceId}, 'Mine', ${`brd-${randomUUID().slice(0, 8)}`})
         RETURNING id`;

      await sql.unsafe(migration);
      await sql.unsafe(migration);

      const boards = await boardsOf(workspaceId);
      assert.deepEqual(
         boards.map((board) => board.id),
         [mine!.id]
      );
   });
});
