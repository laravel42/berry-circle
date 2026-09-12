import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
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
      await deleteWorkspaceBoards(sql, workspaceIds);
      await deleteWorkspaceAgents(sql, workspaceIds);
      await sql`DELETE FROM workspaces WHERE id IN ${sql(workspaceIds)}`;
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
