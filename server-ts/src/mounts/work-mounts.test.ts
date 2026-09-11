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
import { formatMention } from '../work/mentions.ts';
import { workTrackingHooks } from '../work/hooks.ts';
import { commentMounts, issueCommentRoutes } from './comments.ts';
import { commentTrackingRoutes } from './comment-tracking.ts';
import { issueMounts } from './issues.ts';
import { joinLinkMounts } from './join-links.ts';
import { pinMounts } from './pins.ts';
import { savedViewRoutes } from './view-routes.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('work-tracking mounts', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let other: World;
   let joinerId = '';
   const tokens: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'mounts');
      other = await seedWorld(sql, 'mounts-other');
      const [joiner] = await sql`
         INSERT INTO users (id, email, name) VALUES (${randomUUID()}, ${`joiner-${randomUUID().slice(0, 8)}@berry.test`}, 'Joiner')
         RETURNING id`;
      joinerId = joiner?.id as string;

      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const issues = new IssueRepository(sql);
      const boards = new BoardRepository(sql);
      const comments = new CommentRepository(sql);
      const idempotency = new IdempotencyStore(sql);
      const hooks = workTrackingHooks({ sql, issues });
      const commentOptions = {
         sessions,
         comments,
         issues,
         idempotency,
         hooks,
         extensions: commentTrackingRoutes({ sql, comments }),
      };
      const registry = new Registry();
      registry.registerAll(
         workspaceReadMounts({
            sessions,
            sql,
            boards,
            catalogExtensions: workCatalogRoutes(),
            viewExtensions: savedViewRoutes({ sql }),
         })
      );
      registry.registerAll(issueMounts({ sessions, issues, boards, idempotency, nested: issueCommentRoutes(commentOptions) }));
      registry.registerAll(commentMounts(commentOptions));
      registry.registerAll(pinMounts({ sessions, sql }));
      registry.registerAll(joinLinkMounts({ sessions, sql }));
      app = createApp(registry);
      tokens.owner = await issueTestToken(sql, world.ownerId);
      tokens.member = await issueTestToken(sql, world.memberId);
      tokens.viewer = await issueTestToken(sql, world.viewerId);
      tokens.outsider = await issueTestToken(sql, other.ownerId);
      tokens.joiner = await issueTestToken(sql, joinerId);
   });
   after(async () => {
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await sql`DELETE FROM users WHERE id = ${joinerId}`;
      await closeDatabase(sql);
   });

   async function call(method: string, path: string, who: string | null, body?: unknown) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (who) headers.authorization = `Bearer ${tokens[who] ?? ''}`;
      if (method === 'POST' && path.endsWith('/comments')) headers['idempotency-key'] = `key-${randomUUID()}`;
      const response = await app.request(path, {
         method,
         headers,
         ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
   }
   const catalog = (path: string) => `/api/v1/catalogs/${world.workspaceId}${path}`;

   test('properties: an owner creates, a viewer is refused, an outsider sees nothing', async () => {
      const created = await call('POST', catalog('/issue-properties'), 'owner', { name: 'Area', kind: 'select', options: [{ id: 'ui', name: 'UI', color: '#123456' }] });
      assert.equal(created.status, 201);
      assert.equal((await call('POST', catalog('/issue-properties'), 'viewer', { name: 'X', kind: 'text' })).status, 403);
      assert.equal((await call('GET', catalog('/issue-properties'), 'outsider')).status, 404);
      const listed = await call('GET', catalog('/issue-properties'), 'viewer');
      assert.equal((listed.body?.nodes as unknown[]).length, 1);
   });

   test('statuses: create, reorder, and a system status refuses archive', async () => {
      const created = await call('POST', catalog('/issue-statuses'), 'owner', { name: 'Waiting on design', category: 'blocked', color: '#d97706' });
      assert.equal(created.status, 201);
      const statuses = await call('GET', catalog('/issue-statuses'), 'owner');
      const nodes = statuses.body?.nodes as Array<{ id: string; isSystem: boolean }>;
      const system = nodes.find((node) => node.isSystem);
      assert.equal((await call('DELETE', catalog(`/issue-statuses/${system?.id}`), 'owner')).status, 409);
      const order = await call('PUT', catalog('/issue-statuses/order'), 'owner', { ids: nodes.map((node) => node.id).reverse() });
      assert.equal(order.status, 200);
   });

   test('a catalog write finds its row before the permission: absent or foreign is 404 for every role, own is 403', async () => {
      const tag = randomUUID().slice(0, 8);
      const theirs = (path: string) => `/api/v1/catalogs/${other.workspaceId}${path}`;
      const make = async (path: string, mine: unknown, foreign: unknown = mine): Promise<[string, string]> => {
         const own = await call('POST', catalog(path), 'owner', mine);
         const their = await call('POST', theirs(path), 'outsider', foreign);
         assert.equal(own.status, 201, `own ${path}`);
         assert.equal(their.status, 201, `foreign ${path}`);
         return [own.body?.id as string, their.body?.id as string];
      };
      const labels = await make('/issue-labels', { name: `probe-${tag}` });
      const properties = await make('/issue-properties', { name: `Probe ${tag}`, kind: 'text' });
      const statuses = await make('/issue-statuses', { name: `Probe ${tag}`, category: 'blocked', color: '#d97706' });
      const links = await make('/join-links', { role: 'member', maxUses: 5 });
      const actions = await make(
         '/quick-actions',
         { name: `Probe ${tag}`, targetAgentId: world.agentId, prompt: 'Go.' },
         { name: `Probe ${tag}`, targetAgentId: other.agentId, prompt: 'Go.' }
      );
      // A member lacks settings.write and invitations.write; a viewer lacks product.write.
      const probes: Array<{ method: string; path: string; who: string; ids: [string, string]; body?: unknown }> = [
         { method: 'PATCH', path: '/issue-labels/', who: 'member', ids: labels, body: { name: 'renamed' } },
         { method: 'DELETE', path: '/issue-labels/', who: 'member', ids: labels },
         { method: 'PATCH', path: '/issue-properties/', who: 'member', ids: properties, body: { name: 'Renamed' } },
         { method: 'DELETE', path: '/issue-properties/', who: 'member', ids: properties },
         { method: 'PATCH', path: '/issue-statuses/', who: 'member', ids: statuses, body: { name: 'Renamed' } },
         { method: 'DELETE', path: '/issue-statuses/', who: 'member', ids: statuses },
         { method: 'PATCH', path: '/quick-actions/', who: 'viewer', ids: actions, body: { name: 'Renamed' } },
         { method: 'DELETE', path: '/quick-actions/', who: 'viewer', ids: actions },
         { method: 'DELETE', path: '/join-links/', who: 'member', ids: links },
      ];
      const error = (body: Record<string, unknown> | null) => {
         const { requestId: _ignored, ...rest } = (body?.error ?? {}) as Record<string, unknown>;
         return rest;
      };
      for (const { method, path, who, ids: [own, foreign], body } of probes) {
         const label = `${method} ${path} as ${who}`;
         const cross = await call(method, catalog(`${path}${foreign}`), who, body);
         const absent = await call(method, catalog(`${path}${randomUUID()}`), who, body);
         assert.equal(cross.status, 404, `${label}: another workspace's row`);
         assert.equal(absent.status, 404, `${label}: no row at all`);
         assert.deepEqual(error(cross.body), error(absent.body), `${label}: the two 404s read the same`);
         assert.equal((await call(method, catalog(`${path}${own}`), who, body)).status, 403, `${label}: own row`);
      }
   });

   test('join links: created with a token, looked up without a session, accepted once', async () => {
      const created = await call('POST', catalog('/join-links'), 'owner', { role: 'member', maxUses: 5 });
      assert.equal(created.status, 201);
      const token = created.body?.token as string;
      const lookup = await call('GET', `/api/v1/join-links/${token}`, null);
      assert.deepEqual(lookup.body?.workspace, { id: world.workspaceId, name: (lookup.body?.workspace as { name: string }).name });
      assert.equal((await call('GET', `/api/v1/join-links/berry_join_nope`, null)).status, 404);
      const accepted = await call('POST', `/api/v1/join-links/${token}/accept`, 'joiner');
      assert.deepEqual(accepted.body, { workspaceId: world.workspaceId, role: 'member', joined: true });
      assert.equal((await call('GET', catalog('/join-links'), 'member')).status, 403);
   });

   test('views: create, edit at a revision, query, and remember preferences', async () => {
      const created = await call('POST', '/api/v1/views', 'member', { workspaceId: world.workspaceId, name: 'Board', query: {} });
      assert.equal(created.status, 201);
      const id = created.body?.id as string;
      assert.equal((await call('PATCH', `/api/v1/views/${id}`, 'member', { name: 'Board 2', revision: 1 })).status, 200);
      assert.equal((await call('PATCH', `/api/v1/views/${id}`, 'member', { name: 'Stale', revision: 1 })).status, 409);
      const query = await call('POST', '/api/v1/views/query', 'member', { workspaceId: world.workspaceId, groupBy: 'status' });
      assert.equal(query.status, 200);
      assert.ok(Array.isArray(query.body?.groups));
      await call('PUT', '/api/v1/views/preferences', 'member', { workspaceId: world.workspaceId, activeViewId: id, preferences: { layout: 'table' } });
      const prefs = await call('GET', `/api/v1/views/preferences?workspaceId=${world.workspaceId}`, 'member');
      assert.equal(prefs.body?.activeViewId, id);
      assert.equal((await call('DELETE', `/api/v1/views/${id}`, 'outsider')).status, 404);
   });

   test('pins: pin, list, unpin', async () => {
      const pinned = await call('POST', '/api/v1/pins', 'member', { workspaceId: world.workspaceId, targetType: 'issue', targetId: world.issueId });
      assert.equal(pinned.status, 201);
      const listed = await call('GET', `/api/v1/pins?workspaceId=${world.workspaceId}`, 'member');
      assert.equal((listed.body?.nodes as unknown[]).length, 1);
      assert.equal((await call('DELETE', `/api/v1/pins/${pinned.body?.id}?workspaceId=${world.workspaceId}`, 'member')).status, 204);
      assert.equal((await call('POST', '/api/v1/pins', 'outsider', { workspaceId: world.workspaceId, targetType: 'issue', targetId: world.issueId })).status, 404);
   });

   test('comments: a mention subscribes and notifies; reactions and resolution work', async () => {
      const body = `Please look ${formatMention('user', world.viewerId, 'Viewer')}`;
      const created = await call('POST', `/api/v1/issues/${world.issueId}/comments`, 'owner', { body });
      assert.equal(created.status, 201);
      const commentId = created.body?.id as string;
      const [inbox] = await sql`
         SELECT category FROM inbox_items WHERE recipient_id = ${world.viewerId} AND issue_id = ${world.issueId}`;
      assert.equal(inbox?.category, 'mentions');

      const reacted = await call('POST', `/api/v1/comments/${commentId}/reactions`, 'member', { emoji: '👍' });
      assert.equal((reacted.body?.nodes as unknown[]).length, 1);
      const resolved = await call('POST', `/api/v1/comments/${commentId}/resolution`, 'member');
      assert.notEqual(resolved.body?.resolvedAt, null);
      const reopened = await call('DELETE', `/api/v1/comments/${commentId}/resolution`, 'member');
      assert.equal(reopened.body?.resolvedAt, null);
      assert.equal((await call('POST', `/api/v1/comments/${commentId}/resolution`, 'viewer')).status, 403);
   });
});
