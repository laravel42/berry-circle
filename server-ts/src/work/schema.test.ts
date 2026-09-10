import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

function hasCode(code: string): (error: unknown) => boolean {
   return (error) => (error as { code?: string }).code === code;
}

describe('work-tracking schema (060-064)', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let other: World;

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'schema');
      other = await seedWorld(sql, 'schema-other');
   });

   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   test('a person property carries no options, and a person property with options is refused', async () => {
      await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${world.workspaceId}, 'Reviewer', 'person')`;
      await assert.rejects(
         sql`
            INSERT INTO issue_property_definitions (workspace_id, name, kind, config)
            VALUES (${world.workspaceId}, 'Pair', 'multi_person',
                    ${sql.json({ options: [{ id: 'a', name: 'A', color: '#111111' }] } as never)})`,
         hasCode('23514')
      );
   });

   test('a person value is stored, and a malformed one is refused by the value trigger', async () => {
      const [definition] = await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${world.workspaceId}, 'Pairing', 'multi_person')
         RETURNING id`;
      const propertyId = definition?.id as string;
      await sql`
         INSERT INTO issue_property_values (workspace_id, issue_id, property_id, value)
         VALUES (${world.workspaceId}, ${world.issueId}, ${propertyId},
                 ${sql.json([{ type: 'user', id: world.memberId }, { type: 'agent', id: world.agentId }] as never)})`;
      await assert.rejects(
         sql`
            UPDATE issue_property_values SET value = ${sql.json([{ type: 'team', id: world.memberId }] as never)}
             WHERE issue_id = ${world.issueId} AND property_id = ${propertyId}`,
         hasCode('23514')
      );
   });

   test('an issue starts with empty metadata', async () => {
      const [row] = await sql`SELECT metadata FROM issues WHERE id = ${world.issueId}`;
      assert.deepEqual(row?.metadata, {});
   });

   test('a parent in another workspace is refused', async () => {
      await assert.rejects(
         sql`UPDATE issues SET parent_id = ${other.issueId} WHERE id = ${world.issueId}`,
         hasCode('23503')
      );
   });

   test('an issue cannot be its own parent', async () => {
      await assert.rejects(
         sql`UPDATE issues SET parent_id = id WHERE id = ${world.issueId}`,
         hasCode('23514')
      );
   });

   test('a custom status must match the category, and a plain status change drops it', async () => {
      const [definition] = await sql`
         INSERT INTO issue_status_definitions (workspace_id, key, name, category, color, sort_order)
         VALUES (${world.workspaceId}, 'cqa', 'QA', 'in_review', '#8b5cf6', 4100)
         RETURNING id`;
      const issueId = await createIssue(sql, world, { status: 'in_review' });
      await sql`UPDATE issues SET status_id = ${definition?.id as string} WHERE id = ${issueId}`;
      await sql`UPDATE issues SET status = 'todo' WHERE id = ${issueId}`;
      const [row] = await sql`SELECT status_id FROM issues WHERE id = ${issueId}`;
      assert.equal(row?.status_id, null);
      await assert.rejects(
         sql`UPDATE issues SET status_id = ${definition?.id as string} WHERE id = ${issueId}`,
         hasCode('23514')
      );
   });

   test('mentioned is a subscription reason', async () => {
      await sql`
         INSERT INTO issue_subscribers (workspace_id, issue_id, user_id, reason)
         VALUES (${world.workspaceId}, ${world.issueId}, ${world.memberId}, 'mentioned')
         ON CONFLICT (issue_id, user_id) DO UPDATE SET reason = 'mentioned'`;
   });

   test('a join link cannot grant owner', async () => {
      await assert.rejects(
         sql`
            INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by)
            VALUES (${world.workspaceId}, 'owner', ${Buffer.alloc(32, 1)}, ${world.ownerId})`,
         hasCode('23514')
      );
   });
});
