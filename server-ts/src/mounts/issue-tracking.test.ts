import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SessionService } from '../auth/sessions.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { cleanupWorld, createIssue, seedWorld, type World } from '../work/fixture.ts';
import { createProperty, propertyCreateSchema } from '../work/properties.ts';
import { createQuickAction, quickActionCreateSchema, type QuickActionEnqueue } from '../work/quick-actions.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { stageGate } from '../work/hierarchy.ts';
import { issueMounts } from './issues.ts';
import { issueTrackingRoutes } from './issue-tracking.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('issue-tracking routes', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let other: World;
   const tokens: Record<string, string> = {};
   const admitted: string[] = [];
   const enqueued: string[] = [];

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'track');
      other = await seedWorld(sql, 'track-other');
      const sessions = new SessionService({ sql, sessionTtlMs: 3_600_000 });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const dispatch = {
         admit: async (input: { issueId: string }) => {
            admitted.push(input.issueId);
            return {} as never;
         },
      };
      const enqueue: QuickActionEnqueue = async (_sql, input) => {
         enqueued.push(input.prompt ?? '');
         return { runId: 'run-quick' };
      };
      const hooks = workTrackingHooks({ sql, issues, dispatch });
      const registry = new Registry();
      registry.registerAll(
         issueMounts({
            sessions,
            issues,
            boards,
            idempotency: new IdempotencyStore(sql),
            stages: stageGate(sql),
            hooks,
            tracking: issueTrackingRoutes({ sql, issues, boards, comments, dispatch, enqueue, hooks }),
         })
      );
      app = createApp(registry);
      tokens.owner = (await sessions.issueForUser(world.ownerId)).token;
      tokens.viewer = (await sessions.issueForUser(world.viewerId)).token;
      tokens.outsider = (await sessions.issueForUser(other.ownerId)).token;
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   async function call(method: string, path: string, who: string, body?: unknown) {
      const response = await app.request(path, {
         method,
         headers: { authorization: `Bearer ${tokens[who] ?? ''}`, 'content-type': 'application/json' },
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
   }

   test('a property value is set, read back, and refused when it does not fit', async () => {
      const effort = await createProperty(sql, world.workspaceId, world.ownerId, propertyCreateSchema.parse({ name: 'Effort', kind: 'number' }));
      const set = await call('PUT', `/api/v1/issues/${world.issueId}/properties/${effort.id}`, 'owner', { value: 3 });
      assert.equal(set.status, 200);
      const listed = await call('GET', `/api/v1/issues/${world.issueId}/properties`, 'owner');
      assert.deepEqual(listed.body?.nodes, [{ propertyId: effort.id, value: 3 }]);
      const bad = await call('PUT', `/api/v1/issues/${world.issueId}/properties/${effort.id}`, 'owner', { value: 'three' });
      assert.equal(bad.status, 422);
   });

   test('an outsider gets 404 and a viewer gets 403 on a write', async () => {
      assert.equal((await call('GET', `/api/v1/issues/${world.issueId}/properties`, 'outsider')).status, 404);
      assert.equal((await call('PATCH', `/api/v1/issues/${world.issueId}/metadata`, 'viewer', { set: { a: 1 } })).status, 403);
   });

   test('reactions and subscription round-trip', async () => {
      const reacted = await call('POST', `/api/v1/issues/${world.issueId}/reactions`, 'owner', { emoji: '🎉' });
      assert.deepEqual((reacted.body?.nodes as Array<{ emoji: string }>).map((node) => node.emoji), ['🎉']);
      const removed = await call('DELETE', `/api/v1/issues/${world.issueId}/reactions/${encodeURIComponent('🎉')}`, 'owner');
      assert.deepEqual(removed.body?.nodes, []);
      const subscribed = await call('PUT', `/api/v1/issues/${world.issueId}/subscription`, 'viewer', { subtree: false });
      assert.equal(subscribed.body?.subscribed, true);
      const listed = await call('GET', `/api/v1/issues/${world.issueId}/subscribers`, 'viewer');
      assert.equal(listed.body?.subscribed, true);
   });

   test('a sub-issue is created from a comment and counted on its parent', async () => {
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${world.issueId}, 'user', ${world.ownerId}, ${'Split out the parser\nDetails here'})
         RETURNING id`;
      const child = await call('POST', `/api/v1/issues/${world.issueId}/children`, 'owner', { fromCommentId: comment?.id });
      assert.equal(child.status, 201);
      assert.equal(child.body?.title, 'Split out the parser');
      assert.equal(child.body?.parentId, world.issueId);
      const children = await call('GET', `/api/v1/issues/${world.issueId}/children`, 'owner');
      assert.equal((children.body?.progress as { total: number }).total >= 1, true);
   });

   test('finishing stage one releases stage two to its agent', async () => {
      const parent = await createIssue(sql, world, { title: 'Staged parent' });
      const first = await createIssue(sql, world, { parentId: parent, stage: 1, status: 'in_review' });
      const second = await createIssue(sql, world, { parentId: parent, stage: 2, status: 'todo', agentAssignee: true });
      const done = await call('PATCH', `/api/v1/issues/${first}`, 'owner', { status: 'done' });
      assert.equal(done.status, 200);
      assert.ok(admitted.includes(second));
   });

   test('a batch reports what it could not change', async () => {
      const a = await createIssue(sql, world);
      const result = await call('POST', '/api/v1/issues/batch', 'owner', { issueIds: [a, other.issueId], patch: { priority: 'high' } });
      assert.deepEqual(result.body, { updated: [a], failed: [{ id: other.issueId, code: 'NOT_FOUND' }] });
   });

   test('a quick action queues an agent task with its rendered prompt', async () => {
      const action = await createQuickAction(sql, world.workspaceId, world.ownerId, quickActionCreateSchema.parse({ name: 'Explain', targetAgentId: world.agentId, prompt: 'Explain {{issue.title}}' }));
      const run = await call('POST', `/api/v1/issues/${world.issueId}/quick-actions/${action.id}/run`, 'owner');
      assert.equal(run.status, 202);
      assert.deepEqual(run.body, { runId: 'run-quick' });
      assert.ok(enqueued.includes('Explain Root task'));
   });

   test('the timeline lists the property change', async () => {
      const activity = await call('GET', `/api/v1/issues/${world.issueId}/activity`, 'owner');
      const types = (activity.body?.nodes as Array<{ type: string }>).map((node) => node.type);
      assert.ok(types.includes('issue.properties.changed'));
   });
});
