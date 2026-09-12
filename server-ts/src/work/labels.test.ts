import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from '../identity/errors.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from './fixture.ts';
import { issueLabelsSchema, listIssueLabels, setIssueLabels } from './labels.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue labels', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let bug = '';
   let chore = '';
   let retired = '';
   /** A label in another workspace, to prove the write is scoped. */
   let foreignWorkspaceId = '';
   let foreignLabel = '';

   const newLabel = async (workspaceId: string, name: string, archived = false): Promise<string> => {
      const [row] = await sql`
         INSERT INTO issue_labels (id, workspace_id, name, color, archived_at)
         VALUES (${randomUUID()}, ${workspaceId}, ${name}, '#112233',
                 ${archived ? new Date().toISOString() : null})
         RETURNING id`;
      return row!.id as string;
   };

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'labels');
      bug = await newLabel(world.workspaceId, `bug-${randomUUID().slice(0, 8)}`);
      chore = await newLabel(world.workspaceId, `chore-${randomUUID().slice(0, 8)}`);
      retired = await newLabel(world.workspaceId, `retired-${randomUUID().slice(0, 8)}`, true);

      const [foreign] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, 'Other', ${`other-${randomUUID().slice(0, 8)}`},
                 ${sql.json({ issuePrefix: 'OTH', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${world.ownerId})
         RETURNING id`;
      foreignWorkspaceId = foreign!.id as string;
      foreignLabel = await newLabel(foreignWorkspaceId, `foreign-${randomUUID().slice(0, 8)}`);
   });

   after(async () => {
      if (foreignWorkspaceId) {
         await sql`DELETE FROM issue_labels WHERE workspace_id = ${foreignWorkspaceId}`;
         await sql`DELETE FROM issue_status_definitions WHERE workspace_id = ${foreignWorkspaceId}`;
         await sql.begin(async (tx) => {
            await tx`SET LOCAL session_replication_role = replica`;
            await tx`DELETE FROM agents WHERE workspace_id = ${foreignWorkspaceId}`;
         });
         await deleteWorkspaceBoards(sql, [foreignWorkspaceId]);
         await sql`DELETE FROM workspaces WHERE id = ${foreignWorkspaceId}`;
      }
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('the body takes a bounded list of uuids and nothing else', () => {
      assert.equal(issueLabelsSchema.safeParse({ labelIds: [] }).success, true);
      assert.equal(issueLabelsSchema.safeParse({ labelIds: ['nope'] }).success, false);
      assert.equal(
         issueLabelsSchema.safeParse({ labelIds: [], extra: 1 }).success,
         false,
         'an unknown field is a refusal, not a silently dropped one'
      );
   });

   test('a task starts with no labels', async () => {
      assert.deepEqual(await listIssueLabels(sql, world.workspaceId, world.issueId), []);
   });

   test('setting labels replaces the set, and is stable when repeated', async () => {
      const issueId = await createIssue(sql, world, { title: 'Labelled' });

      const first = await setIssueLabels(sql, {
         workspaceId: world.workspaceId,
         issueId,
         labelIds: [bug, chore],
         actorId: world.ownerId,
      });
      assert.deepEqual(new Set(first.map((label) => label.id)), new Set([bug, chore]));

      // Repeating the same set writes nothing new and answers the same thing.
      const again = await setIssueLabels(sql, {
         workspaceId: world.workspaceId,
         issueId,
         labelIds: [chore, bug],
         actorId: world.ownerId,
      });
      assert.deepEqual(again.map((label) => label.id).sort(), first.map((label) => label.id).sort());

      // A narrower set removes the one left out rather than adding.
      const narrowed = await setIssueLabels(sql, {
         workspaceId: world.workspaceId,
         issueId,
         labelIds: [chore],
         actorId: world.ownerId,
      });
      assert.deepEqual(
         narrowed.map((label) => label.id),
         [chore]
      );

      const cleared = await setIssueLabels(sql, {
         workspaceId: world.workspaceId,
         issueId,
         labelIds: [],
         actorId: world.ownerId,
      });
      assert.deepEqual(cleared, []);
      assert.deepEqual(await listIssueLabels(sql, world.workspaceId, issueId), []);
   });

   test('one task keeps its labels when another is changed', async () => {
      const left = await createIssue(sql, world, { title: 'Left' });
      const right = await createIssue(sql, world, { title: 'Right' });
      await setIssueLabels(sql, { workspaceId: world.workspaceId, issueId: left, labelIds: [bug], actorId: world.ownerId });
      await setIssueLabels(sql, { workspaceId: world.workspaceId, issueId: right, labelIds: [chore], actorId: world.ownerId });
      assert.deepEqual((await listIssueLabels(sql, world.workspaceId, left)).map((l) => l.id), [bug]);
      assert.deepEqual((await listIssueLabels(sql, world.workspaceId, right)).map((l) => l.id), [chore]);
   });

   test("another workspace's label cannot be put on a task", async () => {
      const issueId = await createIssue(sql, world, { title: 'Foreign' });
      await assert.rejects(
         setIssueLabels(sql, {
            workspaceId: world.workspaceId,
            issueId,
            labelIds: [foreignLabel],
            actorId: world.ownerId,
         }),
         NotFound
      );
      assert.deepEqual(await listIssueLabels(sql, world.workspaceId, issueId), []);
   });

   test('an archived label cannot be put on a task', async () => {
      const issueId = await createIssue(sql, world, { title: 'Archived' });
      await assert.rejects(
         setIssueLabels(sql, {
            workspaceId: world.workspaceId,
            issueId,
            labelIds: [retired],
            actorId: world.ownerId,
         }),
         NotFound
      );
      assert.deepEqual(await listIssueLabels(sql, world.workspaceId, issueId), []);
   });

   test('a refused id leaves the labels already on the task alone', async () => {
      const issueId = await createIssue(sql, world, { title: 'Kept' });
      await setIssueLabels(sql, { workspaceId: world.workspaceId, issueId, labelIds: [bug], actorId: world.ownerId });
      await assert.rejects(
         sql.begin((tx) =>
            setIssueLabels(tx, {
               workspaceId: world.workspaceId,
               issueId,
               labelIds: [chore, randomUUID()],
               actorId: world.ownerId,
            })
         ),
         NotFound
      );
      assert.deepEqual((await listIssueLabels(sql, world.workspaceId, issueId)).map((l) => l.id), [bug]);
   });
});
