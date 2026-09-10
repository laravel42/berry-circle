// Cross-tenant guarantees for every work-tracking mount (spec §11): a member of
// W1 reading or writing W2's work-tracking resources gets the same 404 as a
// random id, W2 is unchanged, and an anonymous caller is refused first.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { CommentRepository } from '../core/comments.ts';
import { IssueRepository } from '../core/issues.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { Registry } from '../http/registry.ts';
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { commentMounts, issueCommentRoutes } from './comments.ts';
import { commentTrackingRoutes } from './comment-tracking.ts';
import { issueMounts } from './issues.ts';
import { issueTrackingRoutes } from './issue-tracking.ts';
import { joinLinkMounts } from './join-links.ts';
import { pinMounts } from './pins.ts';
import { savedViewRoutes } from './view-routes.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work tracking: cross-tenant leakage', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let w1: World;
   let w2: World;
   let token = '';
   let w2CommentId = '';
   let w2ViewId = '';
   let w2ActionId = '';
   let w2LinkId = '';
   let w2PropertyId = '';

   before(async () => {
      sql = openDatabase({ url: url as string });
      w1 = await seedWorld(sql, 'leak-1');
      w2 = await seedWorld(sql, 'leak-2');
      const [comment] = await sql`
         INSERT INTO comments (issue_id, author_type, author_id, body)
         VALUES (${w2.issueId}, 'user', ${w2.ownerId}, 'W2 only') RETURNING id`;
      w2CommentId = comment?.id as string;
      // W2-owned rows that W1 will try to change by id.
      const [view] = await sql`
         INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query)
         VALUES (${w2.workspaceId}, ${w2.ownerId}, 'W2 view', 'workspace', ${sql.json({} as never)})
         RETURNING id`;
      w2ViewId = view?.id as string;
      const [action] = await sql`
         INSERT INTO quick_action_definitions (workspace_id, name, target_agent_id, prompt, visibility, created_by)
         VALUES (${w2.workspaceId}, 'W2 action', ${w2.agentId}, 'Do it', 'workspace', ${w2.ownerId})
         RETURNING id`;
      w2ActionId = action?.id as string;
      const [link] = await sql`
         INSERT INTO workspace_join_links (workspace_id, role, token_hash, created_by)
         VALUES (${w2.workspaceId}, 'member', ${Buffer.alloc(32, 7)}, ${w2.ownerId})
         RETURNING id`;
      w2LinkId = link?.id as string;
      const [property] = await sql`
         INSERT INTO issue_property_definitions (workspace_id, name, kind)
         VALUES (${w2.workspaceId}, 'W2 field', 'text')
         RETURNING id`;
      w2PropertyId = property?.id as string;

      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const idempotency = new IdempotencyStore(sql);
      const hooks = workTrackingHooks({ sql, issues });
      const commentOptions = { sessions, comments, issues, idempotency, hooks, extensions: commentTrackingRoutes({ sql, comments }) };
      const registry = new Registry();
      registry.registerAll(workspaceReadMounts({ sessions, sql, boards, catalogExtensions: workCatalogRoutes(), viewExtensions: savedViewRoutes({ sql }) }));
      registry.registerAll(
         issueMounts({
            sessions,
            issues,
            boards,
            idempotency,
            hooks,
            nested: issueCommentRoutes(commentOptions),
            tracking: issueTrackingRoutes({ sql, issues, boards, comments, hooks }),
         })
      );
      registry.registerAll(commentMounts(commentOptions));
      registry.registerAll(pinMounts({ sessions, sql }));
      registry.registerAll(joinLinkMounts({ sessions, sql }));
      app = createApp(registry);
      token = await issueTestToken(sql, w1.ownerId);
   });
   after(async () => {
      await cleanupWorld(sql, w1);
      await cleanupWorld(sql, w2);
      await closeDatabase(sql);
   });

   async function as(method: string, path: string, body?: unknown, auth = true) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (auth) headers.authorization = `Bearer ${token}`;
      const response = await app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return response.status;
   }

   test('reads of another workspace are 404', async () => {
      const reads = [
         `/api/v1/issues/${w2.issueId}/properties`,
         `/api/v1/issues/${w2.issueId}/metadata`,
         `/api/v1/issues/${w2.issueId}/reactions`,
         `/api/v1/issues/${w2.issueId}/subscribers`,
         `/api/v1/issues/${w2.issueId}/children`,
         `/api/v1/issues/${w2.issueId}/activity`,
         `/api/v1/comments/${w2CommentId}/reactions`,
         `/api/v1/catalogs/${w2.workspaceId}/issue-properties`,
         `/api/v1/catalogs/${w2.workspaceId}/quick-actions`,
         `/api/v1/catalogs/${w2.workspaceId}/join-links`,
         `/api/v1/pins?workspaceId=${w2.workspaceId}`,
         `/api/v1/views/preferences?workspaceId=${w2.workspaceId}`,
         `/api/v1/issues/assignee-frequency?workspaceId=${w2.workspaceId}`,
      ];
      for (const path of reads) assert.equal(await as('GET', path), 404, path);
   });

   test('writes to another workspace are 404 and change nothing', async () => {
      const writes: Array<[string, string, unknown]> = [
         ['PUT', `/api/v1/issues/${w2.issueId}/subscription`, {}],
         ['POST', `/api/v1/issues/${w2.issueId}/reactions`, { emoji: '👍' }],
         ['PATCH', `/api/v1/issues/${w2.issueId}/metadata`, { set: { leaked: true } }],
         ['POST', `/api/v1/issues/${w2.issueId}/children`, { title: 'Leak' }],
         ['POST', `/api/v1/comments/${w2CommentId}/resolution`, undefined],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/issue-properties`, { name: 'Leak', kind: 'text' }],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/join-links`, {}],
         ['POST', '/api/v1/views/query', { workspaceId: w2.workspaceId }],
         ['POST', '/api/v1/views', { workspaceId: w2.workspaceId, name: 'Leak', query: {} }],
         ['POST', '/api/v1/pins', { workspaceId: w2.workspaceId, targetType: 'issue', targetId: w2.issueId }],
         ['POST', '/api/v1/pins', { workspaceId: w1.workspaceId, targetType: 'issue', targetId: w2.issueId }],
         ['POST', '/api/v1/issues/quick', { workspaceId: w2.workspaceId, title: 'Leak' }],
         ['PUT', `/api/v1/issues/${w2.issueId}/properties/${w2PropertyId}`, { value: 'leak' }],
         ['PUT', `/api/v1/issues/${w2.issueId}/status`, { statusId: randomUUID() }],
         ['POST', `/api/v1/issues/${w2.issueId}/move`, {}],
         ['POST', `/api/v1/issues/${w2.issueId}/quick-actions/${w2ActionId}/run`, undefined],
         ['POST', `/api/v1/issues/${w1.issueId}/quick-actions/${w2ActionId}/run`, undefined],
         ['POST', `/api/v1/comments/${w2CommentId}/reactions`, { emoji: '👍' }],
         ['PATCH', `/api/v1/catalogs/${w2.workspaceId}/issue-properties/${w2PropertyId}`, { name: 'Leak' }],
         ['PATCH', `/api/v1/catalogs/${w1.workspaceId}/issue-properties/${w2PropertyId}`, { name: 'Leak' }],
         ['POST', `/api/v1/catalogs/${w2.workspaceId}/issue-statuses`, { name: 'Leak', category: 'todo', color: '#123456' }],
         ['PATCH', `/api/v1/catalogs/${w2.workspaceId}/quick-actions/${w2ActionId}`, { name: 'Leak' }],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/quick-actions/${w2ActionId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w2.workspaceId}/join-links/${w2LinkId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/join-links/${w2LinkId}`, undefined],
         ['PATCH', `/api/v1/views/${w2ViewId}`, { name: 'Leak', revision: 1 }],
         ['DELETE', `/api/v1/views/${w2ViewId}`, undefined],
         ['PUT', '/api/v1/views/preferences', { workspaceId: w2.workspaceId, activeViewId: null, preferences: {} }],
         ['PUT', '/api/v1/views/preferences', { workspaceId: w1.workspaceId, activeViewId: w2ViewId, preferences: {} }],
         ['POST', '/api/v1/pins', { workspaceId: w1.workspaceId, targetType: 'view', targetId: w2ViewId }],
         ['POST', '/api/v1/issues/batch-delete', { issueIds: [w2.issueId] }],
         // Re-parenting W1's issue under W2's: the one 422 by design (PARENT_NOT_FOUND).
         ['PUT', `/api/v1/issues/${w1.issueId}/parent`, { parentId: w2.issueId }],
         // Quick create in W1 naming W2's board.
         ['POST', '/api/v1/issues/quick', { workspaceId: w1.workspaceId, boardId: w2.boardId, title: 'Leak' }],
         ['DELETE', `/api/v1/issues/${w2.issueId}/reactions/${encodeURIComponent('👍')}`, undefined],
         ['DELETE', `/api/v1/issues/${w2.issueId}/subscription`, undefined],
         ['DELETE', `/api/v1/issues/${w2.issueId}/properties/${w2PropertyId}`, undefined],
         ['DELETE', `/api/v1/comments/${w2CommentId}/resolution`, undefined],
         ['DELETE', `/api/v1/comments/${w2CommentId}/reactions/${encodeURIComponent('👍')}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w2.workspaceId}/issue-properties/${w2PropertyId}`, undefined],
         ['DELETE', `/api/v1/catalogs/${w1.workspaceId}/issue-properties/${w2PropertyId}`, undefined],
         ['PUT', `/api/v1/catalogs/${w2.workspaceId}/issue-statuses/order`, { ids: [randomUUID()] }],
         ['DELETE', `/api/v1/pins/${randomUUID()}?workspaceId=${w2.workspaceId}`, undefined],
         ['PUT', '/api/v1/pins/order', { workspaceId: w2.workspaceId, ids: [randomUUID()] }],
      ];
      // Only the re-parent answers 422 (PARENT_NOT_FOUND by design); every other
      // cross-tenant write must be the same 404 a random id gets, so a body that
      // fails validation can never hide a leak.
      const UNPROCESSABLE_BY_DESIGN = new Set([`PUT /api/v1/issues/${w1.issueId}/parent`]);
      for (const [method, path, body] of writes) {
         const status = await as(method, path, body);
         const key = `${method} ${path}`;
         if (UNPROCESSABLE_BY_DESIGN.has(key)) assert.ok(status === 404 || status === 422, `${key} answered ${status}`);
         else if (path.startsWith('/api/v1/issues/batch')) assert.equal(status, 200, key);
         else assert.equal(status, 404, key);
      }
      const [w2State] = await sql`
         SELECT
           (SELECT name FROM saved_issue_views WHERE id = ${w2ViewId}) AS view_name,
           (SELECT name FROM quick_action_definitions WHERE id = ${w2ActionId} AND archived_at IS NULL) AS action_name,
           (SELECT revoked_at FROM workspace_join_links WHERE id = ${w2LinkId}) AS link_revoked,
           (SELECT name FROM issue_property_definitions WHERE id = ${w2PropertyId}) AS property_name,
           (SELECT archived_at FROM issue_property_definitions WHERE id = ${w2PropertyId}) AS property_archived,
           (SELECT count(*) FROM issue_property_values WHERE issue_id = ${w2.issueId})::int AS values,
           (SELECT deleted_at FROM issues WHERE id = ${w2.issueId}) AS issue_deleted,
           (SELECT count(*) FROM comment_reactions WHERE comment_id = ${w2CommentId})::int AS comment_reactions,
           (SELECT count(*) FROM user_pins WHERE user_id = ${w1.ownerId})::int AS pins,
           (SELECT count(*) FROM issue_status_definitions WHERE workspace_id = ${w2.workspaceId} AND lower(name) = 'leak')::int AS statuses`;
      assert.deepEqual(w2State, {
         view_name: 'W2 view',
         action_name: 'W2 action',
         link_revoked: null,
         property_name: 'W2 field',
         property_archived: null,
         values: 0,
         issue_deleted: null,
         comment_reactions: 0,
         pins: 0,
         statuses: 0,
      });
      const [counts] = await sql`
         SELECT
           (SELECT count(*) FROM issue_property_definitions WHERE workspace_id = ${w2.workspaceId} AND name <> 'W2 field')::int AS properties,
           (SELECT count(*) FROM issue_subscribers WHERE issue_id = ${w2.issueId} AND user_id = ${w1.ownerId})::int AS subscriptions,
           (SELECT count(*) FROM issue_reactions WHERE issue_id = ${w2.issueId})::int AS reactions,
           (SELECT count(*) FROM workspace_join_links WHERE workspace_id = ${w2.workspaceId} AND id <> ${w2LinkId})::int AS links,
           (SELECT metadata FROM issues WHERE id = ${w2.issueId}) AS metadata,
           (SELECT parent_id FROM issues WHERE id = ${w1.issueId}) AS parent`;
      assert.deepEqual(counts, { properties: 0, subscriptions: 0, reactions: 0, links: 0, metadata: {}, parent: null });
   });

   test('a batch naming another workspace\'s issue reports it not found', async () => {
      const response = await app.request('/api/v1/issues/batch', {
         method: 'POST',
         headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
         body: JSON.stringify({ issueIds: [w2.issueId], patch: { priority: 'high' } }),
      });
      assert.deepEqual(await response.json(), { updated: [], failed: [{ id: w2.issueId, code: 'NOT_FOUND' }] });
   });

   test('an anonymous caller is refused before any handler runs', async () => {
      assert.equal(await as('GET', `/api/v1/issues/${w1.issueId}/properties`, undefined, false), 401);
      assert.equal(await as('GET', `/api/v1/pins?workspaceId=${w1.workspaceId}`, undefined, false), 401);
      assert.equal(await as('POST', `/api/v1/join-links/berry_join_${randomUUID()}/accept`, undefined, false), 401);
   });
});
