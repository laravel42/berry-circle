import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgentsInTransaction } from '../test-support/protected-agents.ts';
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

   const boardsOf = (workspaceId: string, q: Sql = sql) =>
      q`SELECT id, name, slug, created_by FROM boards WHERE workspace_id = ${workspaceId} ORDER BY created_at`;

   /**
    * Applies the shipped migration, hands the transaction to the assertions,
    * and rolls the whole thing back.
    *
    * The backfill visits *every* workspace in the database, and the test files
    * share one. Committing it would hand a board to whichever other file's
    * workspace happened to be boardless at that instant — between its own
    * `DELETE FROM boards` and its `DELETE FROM workspaces` — and that file's
    * teardown would then fail on boards_workspace_id_workspaces_id_fk. Rolled
    * back, no such board outlives this statement.
    *
    * The lock is the other half: it holds off every insert and delete on
    * `workspaces` while the backfill runs, so a workspace this backfill decides
    * to serve cannot be deleted underneath the INSERT (which would fail on the
    * same foreign key, here instead of there). Both are about the shared
    * database, not about the migration, which is applied verbatim either way.
    */
   async function applying(check: (tx: Sql) => Promise<void>, times = 1): Promise<void> {
      class Rollback extends Error {}
      try {
         await sql.begin(async (tx) => {
            await tx`LOCK TABLE workspaces IN SHARE MODE`;
            for (let index = 0; index < times; index += 1) await tx.unsafe(migration);
            await check(tx as unknown as Sql);
            throw new Rollback();
         });
      } catch (error) {
         if (!(error instanceof Rollback)) throw error;
      }
   }

   before(async () => {
      sql = openDatabase({ url: url! });
      const found = (await list()).find((entry) => entry.version === 183);
      assert.ok(found, 'migration 183 is not on disk');
      migration = found.sql;
   });

   after(async () => {
      // Agents first: agents.board_id cascades, so deleting a board takes its
      // protected Orchestrator with it, which the guard trigger refuses. Then
      // boards, which workspaces RESTRICTs on. All three together, so no
      // concurrent backfill can see a boardless workspace of ours.
      if (workspaceIds.length > 0) {
         await sql.begin(async (tx) => {
            await deleteWorkspaceAgentsInTransaction(tx as unknown as Sql, workspaceIds);
            await deleteWorkspaceBoards(tx as unknown as Sql, workspaceIds);
            await tx`DELETE FROM workspaces WHERE id IN ${tx(workspaceIds)}`;
         });
      }
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

      await applying(async (tx) => {
         const boards = await boardsOf(workspaceId, tx);
         assert.equal(boards.length, 1);
         assert.equal(boards[0]!.name, 'Tasks');
      });
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

      await applying(async (tx) => {
         const boards = await boardsOf(workspaceId, tx);
         assert.deepEqual(
            boards.map((board) => board.id),
            [mine!.id]
         );
      }, 2);
   });
});
