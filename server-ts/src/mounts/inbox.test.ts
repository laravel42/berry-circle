// The inbox mount, against a real database.
//
// Two things are asserted here. First, that a reader sees their own rows and
// the detail recorded with them — the inbox page reads the prompt an agent was
// given, and the comment a notification is about, out of `details`, so the
// field has to survive the round trip. Second, that a reader sees nothing
// else: another member's rows in the same workspace are invisible and
// unactionable, and a workspace the caller does not belong to is a 404 rather
// than an empty list, which would confirm the workspace exists.
//
// DB-backed and gated the way the rest of the suite gates itself, so a fresh
// `pnpm test:server` stays green offline.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { InboxRepository } from '../inbox/repository.ts';
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { inboxMounts } from './inbox.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('inbox mount', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   let other: World;
   const tokens: Record<string, string> = {};
   const items = { owned: '', ownedRead: '', ownedArchived: '', foreign: '' };

   async function addItem(input: {
      workspaceId: string;
      recipientId: string;
      title: string;
      eventType?: string;
      issueId?: string | null;
      details?: Record<string, unknown>;
      read?: boolean;
      archived?: boolean;
   }): Promise<string> {
      const id = randomUUID();
      await sql`
         INSERT INTO inbox_items (
            id, workspace_id, recipient_id, event_type, category, severity, issue_id,
            title, body, details, read_at, archived_at
         ) VALUES (
            ${id}, ${input.workspaceId}, ${input.recipientId},
            ${input.eventType ?? 'issue.updated'}, 'updates', 'info', ${input.issueId ?? null},
            ${input.title}, 'body', ${sql.json((input.details ?? {}) as never)},
            ${input.read ? new Date().toISOString() : null},
            ${input.archived ? new Date().toISOString() : null}
         )`;
      return id;
   }

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, 'inbox');
      other = await seedWorld(sql, 'inbox-other');

      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const registry = new Registry();
      registry.registerAll(
         inboxMounts({
            sessions,
            inbox: new InboxRepository(sql),
            boards: new BoardRepository(sql),
         })
      );
      app = createApp(registry);

      tokens.owner = await issueTestToken(sql, world.ownerId);
      tokens.member = await issueTestToken(sql, world.memberId);
      tokens.outsider = await issueTestToken(sql, other.ownerId);

      items.owned = await addItem({
         workspaceId: world.workspaceId,
         recipientId: world.ownerId,
         title: 'The agent finished',
         eventType: 'run.completed',
         issueId: world.issueId,
         details: { prompt: 'Ship the thing', commentId: 'c-1' },
      });
      items.ownedRead = await addItem({
         workspaceId: world.workspaceId,
         recipientId: world.ownerId,
         title: 'Already seen',
         read: true,
      });
      items.ownedArchived = await addItem({
         workspaceId: world.workspaceId,
         recipientId: world.ownerId,
         title: 'Filed away',
         archived: true,
      });
      items.foreign = await addItem({
         workspaceId: world.workspaceId,
         recipientId: world.memberId,
         title: "Somebody else's",
      });
   });

   after(async () => {
      await sql`DELETE FROM inbox_items WHERE id = ANY(${Object.values(items)}::uuid[])`;
      await cleanupWorld(sql, world);
      await cleanupWorld(sql, other);
      await closeDatabase(sql);
   });

   async function call(method: string, path: string, who: string | null, body?: unknown) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (who) headers.authorization = `Bearer ${tokens[who] ?? ''}`;
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const response = await app.fetch(new Request(`http://berry.test${path}`, init));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
   }

   function nodeIds(body: unknown): string[] {
      const nodes = (body as { nodes?: { id: string }[] }).nodes ?? [];
      return nodes.map((node) => node.id);
   }

   test('a reader sees their own active rows, with the detail recorded on them', async () => {
      const response = await call('GET', `/api/v1/inbox?workspaceId=${world.workspaceId}`, 'owner');
      assert.equal(response.status, 200);
      const ids = nodeIds(response.body);
      assert.ok(ids.includes(items.owned));
      assert.ok(ids.includes(items.ownedRead));
      assert.ok(!ids.includes(items.ownedArchived), 'archived rows are not in the active list');
      assert.ok(!ids.includes(items.foreign), "another member's rows are not listed");

      const node = (response.body as { nodes: Record<string, unknown>[] }).nodes.find(
         (candidate) => candidate.id === items.owned
      );
      assert.deepEqual(node?.details, { prompt: 'Ship the thing', commentId: 'c-1' });
      assert.equal(node?.eventType, 'run.completed');
      assert.equal(typeof node?.issueIdentifier, 'string');
   });

   test('a row with no recorded detail still carries an object', async () => {
      const response = await call('GET', `/api/v1/inbox?workspaceId=${world.workspaceId}`, 'owner');
      const node = (response.body as { nodes: Record<string, unknown>[] }).nodes.find(
         (candidate) => candidate.id === items.ownedRead
      );
      assert.deepEqual(node?.details, {});
   });

   test('the archive and the unread filter each return their own slice', async () => {
      const archived = await call(
         'GET',
         `/api/v1/inbox?workspaceId=${world.workspaceId}&state=archived`,
         'owner'
      );
      assert.deepEqual(nodeIds(archived.body), [items.ownedArchived]);

      const unread = await call(
         'GET',
         `/api/v1/inbox?workspaceId=${world.workspaceId}&unread=true`,
         'owner'
      );
      const unreadIds = nodeIds(unread.body);
      assert.ok(unreadIds.includes(items.owned));
      assert.ok(!unreadIds.includes(items.ownedRead));
   });

   test('the unread count ignores what was archived', async () => {
      const before = await call(
         'GET',
         `/api/v1/inbox/unread-count?workspaceId=${world.workspaceId}`,
         'owner'
      );
      assert.equal((before.body as { count: number }).count, 1);
   });

   test("another member's row cannot be acted on", async () => {
      const response = await call('POST', `/api/v1/inbox/${items.foreign}/archive`, 'owner', {
         workspaceId: world.workspaceId,
      });
      assert.equal(response.status, 404);
      const [row] = await sql`SELECT archived_at FROM inbox_items WHERE id = ${items.foreign}`;
      assert.equal(row?.archived_at, null);
   });

   test('a workspace the caller does not belong to is a 404, not an empty list', async () => {
      const listed = await call('GET', `/api/v1/inbox?workspaceId=${world.workspaceId}`, 'outsider');
      assert.equal(listed.status, 404);
      const acted = await call('POST', '/api/v1/inbox/bulk', 'outsider', {
         workspaceId: world.workspaceId,
         itemIds: [items.owned],
         action: 'archive',
      });
      assert.equal(acted.status, 404);
      const [row] = await sql`SELECT archived_at FROM inbox_items WHERE id = ${items.owned}`;
      assert.equal(row?.archived_at, null);
   });

   test('archiving moves a row between the two lists', async () => {
      const archived = await call('POST', `/api/v1/inbox/${items.owned}/archive`, 'owner', {
         workspaceId: world.workspaceId,
      });
      assert.equal(archived.status, 204);
      const list = await call('GET', `/api/v1/inbox?workspaceId=${world.workspaceId}`, 'owner');
      assert.ok(!nodeIds(list.body).includes(items.owned));

      const restored = await call('POST', `/api/v1/inbox/${items.owned}/unarchive`, 'owner', {
         workspaceId: world.workspaceId,
      });
      assert.equal(restored.status, 204);
      const back = await call('GET', `/api/v1/inbox?workspaceId=${world.workspaceId}`, 'owner');
      assert.ok(nodeIds(back.body).includes(items.owned));
   });
});
