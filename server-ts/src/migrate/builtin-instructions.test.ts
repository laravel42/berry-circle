import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgentsInTransaction } from '../test-support/protected-agents.ts';
import { list } from './migrations.ts';

/**
 * Migration 184: the built-in agents say when they cannot do a thing.
 *
 * `agents.instructions` is the system prompt verbatim, so this is the only
 * place the honesty can be stated for an agent nobody configured.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('the built-in agents’ instructions', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let migration = '';
   const workspaceIds: string[] = [];

   async function createWorkspace(label: string): Promise<string> {
      const suffix = randomUUID().slice(0, 8);
      const [workspace] = await sql`
         INSERT INTO workspaces (id, name, slug, settings)
         VALUES (${randomUUID()}, ${`${label} ${suffix}`}, ${`${label}-${suffix}`},
                 ${sql.json({ issuePrefix: 'HON', defaultRole: 'member', allowMemberInvites: false } as never)})
         RETURNING id`;
      const workspaceId = workspace!.id as string;
      workspaceIds.push(workspaceId);
      return workspaceId;
   }

   const instructionsOf = async (workspaceId: string, name: string): Promise<string> => {
      const [agent] = await sql`
         SELECT instructions FROM agents WHERE workspace_id = ${workspaceId} AND name = ${name}`;
      assert.ok(agent, `${name} is missing`);
      return (agent.instructions as string | null) ?? '';
   };

   before(async () => {
      sql = openDatabase({ url: url! });
      const found = (await list()).find((entry) => entry.version === 184);
      assert.ok(found, 'migration 184 is not on disk');
      migration = found.sql;
   });

   after(async () => {
      // The order the schema allows, and one transaction for all of it:
      //
      //   - agents first, because agents.board_id cascades — deleting a board
      //     takes its protected Orchestrator with it, and the guard trigger
      //     refuses that (23001); the helper is what clears `protected` safely.
      //   - then boards, which workspaces RESTRICTs on
      //     (boards_workspace_id_workspaces_id_fk).
      //   - then the workspaces themselves.
      //
      // Together, because migration 183's backfill — which another test file
      // applies against this same database — gives a board to every workspace
      // that has none. Deleting the boards and committing left a window in
      // which that backfill handed these workspaces a fresh board, and the
      // DELETE below then failed on that foreign key. Uncommitted, our boards
      // are still there for anyone else looking, and the workspaces are gone
      // in the same instant they stop having boards.
      if (workspaceIds.length > 0) {
         await sql.begin(async (tx) => {
            await deleteWorkspaceAgentsInTransaction(tx as unknown as Sql, workspaceIds);
            await deleteWorkspaceBoards(tx as unknown as Sql, workspaceIds);
            await tx`DELETE FROM workspaces WHERE id IN ${tx(workspaceIds)}`;
         });
      }
      await closeDatabase(sql);
   });

   test('a new workspace’s Orchestrator and Guide are told to say when they have no tool', async () => {
      const workspaceId = await createWorkspace('honest-new');
      for (const name of ['Orchestrator', 'Guide']) {
         const instructions = await instructionsOf(workspaceId, name);
         assert.match(instructions, /no tool for what someone asks/, name);
         assert.match(instructions, /never describe the action as done/, name);
      }
   });

   test('running the migration again does not say it twice', async () => {
      const workspaceId = await createWorkspace('honest-again');
      await sql.unsafe(migration);
      await sql.unsafe(migration);
      for (const name of ['Orchestrator', 'Guide']) {
         const instructions = await instructionsOf(workspaceId, name);
         assert.equal(instructions.split('never describe the action as done').length - 1, 1, name);
      }
   });

   test('instructions somebody has edited are left alone', async () => {
      const workspaceId = await createWorkspace('honest-edited');
      await sql`
         UPDATE agents SET instructions = 'Mine, and only mine.'
          WHERE workspace_id = ${workspaceId} AND name IN ('Orchestrator', 'Guide')`;
      await sql.unsafe(migration);
      for (const name of ['Orchestrator', 'Guide']) {
         assert.equal(await instructionsOf(workspaceId, name), 'Mine, and only mine.', name);
      }
   });
});
