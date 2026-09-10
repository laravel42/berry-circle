import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { CommentRepository } from '../core/comments.ts';
import { cleanupWorld, seedWorld, type World } from './fixture.ts';
import { addReaction, emojiSchema, listReactions, removeReaction } from './reactions.ts';
import { NotAThreadRoot, setCommentResolution } from './comment-resolution.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('reactions and resolution', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let world: World;
   let comments: CommentRepository;
   before(async () => {
      sql = openDatabase({ url: url as string });
      comments = new CommentRepository(sql);
      world = await seedWorld(sql, 'react');
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await closeDatabase(sql);
   });

   test('whitespace is not an emoji', () => {
      assert.equal(emojiSchema.safeParse('👍').success, true);
      assert.equal(emojiSchema.safeParse('a b').success, false);
   });

   test('reacting twice counts once, and reactions group by emoji', async () => {
      assert.equal(await addReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), true);
      assert.equal(await addReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), false);
      await addReaction(sql, 'issue', world.issueId, world.memberId, '👍');
      await addReaction(sql, 'issue', world.issueId, world.memberId, '🎉');
      const groups = await listReactions(sql, 'issue', world.issueId, world.ownerId);
      assert.deepEqual(
         groups.map((group) => [group.emoji, group.count, group.reactedByMe]),
         [
            ['👍', 2, true],
            ['🎉', 1, false],
         ]
      );
      assert.equal(await removeReaction(sql, 'issue', world.issueId, world.ownerId, '👍'), true);
   });

   test('a comment thread resolves and unresolves at its root only', async () => {
      const root = await comments.create({ issueId: world.issueId, authorId: world.ownerId, body: 'Root', createdAt: new Date().toISOString() });
      const reply = await comments.create({ issueId: world.issueId, authorId: world.ownerId, body: 'Reply', parentId: root.comment.id, createdAt: new Date().toISOString() });
      await addReaction(sql, 'comment', root.comment.id, world.memberId, '👀');
      assert.equal((await listReactions(sql, 'comment', root.comment.id, world.memberId))[0]?.reactedByMe, true);

      const resolved = await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: true });
      assert.deepEqual(resolved, { issueId: world.issueId, changed: true });
      assert.notEqual((await comments.get(root.comment.id)).resolvedAt, null);
      assert.equal((await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: true })).changed, false);
      await assert.rejects(
         setCommentResolution(sql, { commentId: reply.comment.id, actorId: world.ownerId, resolved: true }),
         NotAThreadRoot
      );
      await setCommentResolution(sql, { commentId: root.comment.id, actorId: world.ownerId, resolved: false });
      assert.equal((await comments.get(root.comment.id)).resolvedAt, null);
   });
});
