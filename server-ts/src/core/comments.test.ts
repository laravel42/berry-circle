import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { CommentRepository, InvalidParent, RevisionConflict } from './comments.ts';
import { Forbidden, NotFound } from '../identity/errors.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Comments against a real PostgreSQL. The rules worth testing are the ones the
 * database enforces or the transaction decides: the one-level reply shape, the
 * revision guard, and who may edit whose comment.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('comments', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let comments: CommentRepository;
   const fixture = { workspaceId: '', boardId: '', issueId: '', userId: '', otherId: '', agentId: '' };

   before(async () => {
      sql = openDatabase({ url: url! });
      comments = new CommentRepository(sql);
      await seed(sql, fixture);
   });

   after(async () => {
      await cleanup(sql, fixture);
      await closeDatabase(sql);
   });

   const now = () => new Date().toISOString();

   test('a comment is written with its author resolved', async () => {
      const { comment, event } = await comments.create({
         issueId: fixture.issueId,
         authorId: fixture.userId,
         body: 'The first word.',
         createdAt: now(),
      });
      assert.equal(comment.body, 'The first word.');
      assert.equal(comment.author.type, 'user');
      assert.equal(comment.author.name, 'Commenter');
      assert.equal(comment.revision, 1);
      assert.equal(comment.parentId, null);
      assert.equal(event.type, 'comment.created');

      const read = await comments.get(comment.id);
      assert.deepEqual(read, comment);
   });

   test('an agent author renders as the agent, not as nothing', async () => {
      // A users join alone leaves an agent's comment with a null name, which
      // the UI shows as the literal word "Agent" and no avatar.
      const { comment } = await comments.create({
         issueId: fixture.issueId,
         authorType: 'agent',
         authorId: fixture.agentId,
         body: 'Reporting the result.',
         createdAt: now(),
      });
      assert.equal(comment.author.type, 'agent');
      assert.equal(comment.author.name, 'Reporter');
   });

   test('a reply hangs off a root comment and nothing hangs off a reply', async () => {
      const root = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Root.', createdAt: now(),
      });
      const reply = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Reply.',
         parentId: root.comment.id, createdAt: now(),
      });
      assert.equal(reply.comment.parentId, root.comment.id);

      // One level deep, deliberately: a conversation people can follow, not a
      // tree they have to navigate.
      await assert.rejects(
         () => comments.create({
            issueId: fixture.issueId, authorId: fixture.userId, body: 'Deeper.',
            parentId: reply.comment.id, createdAt: now(),
         }),
         InvalidParent
      );
   });

   test('a parent on another issue is not found rather than accepted', async () => {
      const elsewhere = await createIssue(sql, fixture);
      const foreign = await comments.create({
         issueId: elsewhere, authorId: fixture.userId, body: 'Over here.', createdAt: now(),
      });
      // Not "invalid parent": telling them apart would confirm that a comment
      // id exists on an issue the caller did not name.
      await assert.rejects(
         () => comments.create({
            issueId: fixture.issueId, authorId: fixture.userId, body: 'Cross-linked.',
            parentId: foreign.comment.id, createdAt: now(),
         }),
         NotFound
      );
   });

   test('the page is oldest first and resumes exactly where it stopped', async () => {
      const issueId = await createIssue(sql, fixture);
      for (const body of ['one', 'two', 'three', 'four']) {
         await comments.create({ issueId, authorId: fixture.userId, body, createdAt: now() });
      }
      const first = await comments.list(issueId, null, 2);
      assert.deepEqual(first.map((c) => c.body), ['one', 'two']);

      const last = first.at(-1)!;
      const second = await comments.list(issueId, { createdAt: last.createdAt, id: last.id }, 10);
      assert.deepEqual(second.map((c) => c.body), ['three', 'four']);
   });

   test('an edit bumps the revision and a stale one is refused', async () => {
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Before.', createdAt: now(),
      });
      const updated = await comments.update({
         commentId: comment.id, actorId: fixture.userId, moderator: false,
         body: 'After.', expectedRevision: comment.revision, updatedAt: now(),
      });
      assert.equal(updated.comment.body, 'After.');
      assert.equal(updated.comment.revision, comment.revision + 1);
      assert.equal(updated.event.type, 'comment.updated');

      // Without this two people editing the same comment overwrite each other,
      // and the second never learns the first wrote anything.
      await assert.rejects(
         () => comments.update({
            commentId: comment.id, actorId: fixture.userId, moderator: false,
            body: 'Racing.', expectedRevision: comment.revision, updatedAt: now(),
         }),
         (error: unknown) =>
            error instanceof RevisionConflict && error.currentRevision === comment.revision + 1
      );
   });

   test('an edit without a revision is allowed, because the caller claimed nothing', async () => {
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Loose.', createdAt: now(),
      });
      const updated = await comments.update({
         commentId: comment.id, actorId: fixture.userId, moderator: false,
         body: 'Loosely edited.', updatedAt: now(),
      });
      assert.equal(updated.comment.body, 'Loosely edited.');
   });

   test('somebody else may not edit or delete your comment, but a moderator may', async () => {
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Mine.', createdAt: now(),
      });
      await assert.rejects(
         () => comments.update({
            commentId: comment.id, actorId: fixture.otherId, moderator: false,
            body: 'Theirs now.', updatedAt: now(),
         }),
         Forbidden
      );
      const moderated = await comments.update({
         commentId: comment.id, actorId: fixture.otherId, moderator: true,
         body: 'Moderated.', updatedAt: now(),
      });
      assert.equal(moderated.comment.body, 'Moderated.');
   });

   test("an agent's comment is not a user's to edit", async () => {
      // It is the record of what a run reported, and a user editing it would
      // rewrite what the agent said.
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorType: 'agent', authorId: fixture.agentId,
         body: 'What the run found.', createdAt: now(),
      });
      await assert.rejects(
         () => comments.update({
            commentId: comment.id, actorId: fixture.userId, moderator: false,
            body: 'Not what it found.', updatedAt: now(),
         }),
         Forbidden
      );
   });

   test('deleting takes the replies with it and describes what went', async () => {
      const root = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Root to remove.', createdAt: now(),
      });
      await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Its reply.',
         parentId: root.comment.id, createdAt: now(),
      });

      const event = await comments.delete({
         commentId: root.comment.id, actorId: fixture.userId, moderator: false, deletedAt: now(),
      });
      assert.equal(event.type, 'comment.deleted');
      // The event carries the comment as it was: a consumer told only an id
      // would have to have kept it to know what disappeared.
      assert.match(event.payload, /Root to remove\./);

      await assert.rejects(() => comments.get(root.comment.id), NotFound);
      const [replies] = await sql`
         SELECT count(*) AS total FROM comments WHERE parent_id = ${root.comment.id}`;
      assert.equal(Number(replies!.total), 0);
   });

   test('a comment on a soft-deleted issue is still editable', async () => {
      // It is still readable, so refusing the edit makes it frozen rather than
      // gone. Go filters the outbox lookup on deleted_at and fails the whole
      // transaction here, which reaches the caller as a 500.
      const issueId = await createIssue(sql, fixture);
      const { comment } = await comments.create({
         issueId, authorId: fixture.userId, body: 'Before the issue went.', createdAt: now(),
      });
      await sql`UPDATE issues SET deleted_at = now() WHERE id = ${issueId}`;

      const updated = await comments.update({
         commentId: comment.id, actorId: fixture.userId, moderator: false,
         body: 'Edited afterwards.', updatedAt: now(),
      });
      assert.equal(updated.comment.body, 'Edited afterwards.');
   });

   test('every mutation is relayed as a jsonb object, never a quoted string', async () => {
      const issueId = await createIssue(sql, fixture);
      const { comment } = await comments.create({
         issueId, authorId: fixture.userId, body: 'Relayed.', createdAt: now(),
      });
      await comments.update({
         commentId: comment.id, actorId: fixture.userId, moderator: false,
         body: 'Relayed twice.', updatedAt: now(),
      });

      const rows = await sql`
         SELECT topic, jsonb_typeof(payload) AS kind, payload
           FROM outbox_events WHERE payload->>'issueId' = ${issueId} ORDER BY occurred_at`;
      assert.equal(rows.length, 2);
      for (const row of rows) assert.equal(row.kind, 'object', `${row.topic} relayed as ${row.kind}`);

      const envelope = rows[0]!.payload as Record<string, unknown>;
      assert.equal(envelope.aggregateType, 'comment');
      assert.equal(envelope.aggregateId, comment.id);
      assert.equal(envelope.workspaceId, fixture.workspaceId);
      assert.equal(envelope.boardId, fixture.boardId);
   });

   test('a comment in another workspace is not found rather than forbidden', async () => {
      const outsider = await createUser(sql, `outsider-${randomUUID().slice(0, 8)}`);
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Private.', createdAt: now(),
      });
      await assert.rejects(
         () => comments.authorize(outsider, comment.id, 'product.read'),
         NotFound
      );
      await sql`DELETE FROM users WHERE id = ${outsider}`;
   });

   test('a viewer may read comments and may not write them', async () => {
      const { comment } = await comments.create({
         issueId: fixture.issueId, authorId: fixture.userId, body: 'Readable.', createdAt: now(),
      });
      const viewer = await createUser(sql, `viewer-${randomUUID().slice(0, 8)}`);
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${fixture.workspaceId}, ${viewer}, 'viewer')`;

      const scope = await comments.authorize(viewer, comment.id, 'product.read');
      assert.equal(scope.role, 'viewer');
      await assert.rejects(() => comments.authorize(viewer, comment.id, 'comments.write'), Forbidden);

      await sql`DELETE FROM workspace_memberships WHERE user_id = ${viewer}`;
      await sql`DELETE FROM users WHERE id = ${viewer}`;
   });
});

async function createUser(sql: Sql, handle: string): Promise<string> {
   const [row] = await sql`
      INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`${handle}@berry.test`}, ${handle})
      RETURNING id`;
   return row!.id as string;
}

async function createIssue(sql: Sql, fixture: Record<string, string>): Promise<string> {
   const id = randomUUID();
   const [counter] = await sql`
      UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${fixture.boardId!}
      RETURNING issue_counter`;
   await sql`
      INSERT INTO issues (id, board_id, number, title, created_by)
      VALUES (${id}, ${fixture.boardId!}, ${Number(counter!.issue_counter)}, 'Commented', ${fixture.userId!})`;
   return id;
}

async function seed(sql: Sql, fixture: Record<string, string>): Promise<void> {
   const suffix = randomUUID().slice(0, 8);
   fixture.userId = await createUser(sql, `commenter-${suffix}`);
   await sql`UPDATE users SET name = 'Commenter' WHERE id = ${fixture.userId}`;
   fixture.otherId = await createUser(sql, `other-${suffix}`);

   const [workspace] = await sql`
      INSERT INTO workspaces (id, name, slug, settings, created_by)
      VALUES (${randomUUID()}, ${`Comments ${suffix}`}, ${`comments-${suffix}`},
              ${sql.json({ issuePrefix: 'CMT', defaultRole: 'member', allowMemberInvites: false } as never)},
              ${fixture.userId})
      RETURNING id`;
   fixture.workspaceId = workspace!.id as string;
   for (const user of [fixture.userId, fixture.otherId]) {
      await sql`
         INSERT INTO workspace_memberships (workspace_id, user_id, role)
         VALUES (${fixture.workspaceId}, ${user}, 'owner')`;
   }

   const [board] = await sql`
      INSERT INTO boards (id, workspace_id, name, slug, created_by)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, 'Comments', ${`cmt-${suffix}`}, ${fixture.userId})
      RETURNING id`;
   fixture.boardId = board!.id as string;

   const [agent] = await sql`
      INSERT INTO agents (id, workspace_id, board_id, name, status)
      VALUES (${randomUUID()}, ${fixture.workspaceId}, ${fixture.boardId},
              'Reporter', 'available')
      RETURNING id`;
   fixture.agentId = agent!.id as string;

   fixture.issueId = await createIssue(sql, fixture);
}

async function cleanup(sql: Sql, fixture: Record<string, string>): Promise<void> {
   if (!fixture.workspaceId) return;
   await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM issues WHERE board_id = ${fixture.boardId!}`;
   await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
   await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
   await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
   for (const id of [fixture.userId, fixture.otherId]) {
      if (id) await sql`DELETE FROM users WHERE id = ${id}`;
   }
}
