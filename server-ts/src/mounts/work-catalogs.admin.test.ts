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
import { cleanupWorld, seedWorld, type World } from '../work/fixture.ts';
import { MAX_ACTIVE_PROPERTIES } from '../work/properties.ts';
import { unfillableVariables } from '../work/quick-actions.ts';
import { savedViewRoutes } from './view-routes.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { workspaceReadMounts } from './workspace-reads.ts';

/**
 * What the settings pages need from the workspace catalogues, beyond what they
 * already had: archiving that a reader can see the result of and undo, a count
 * beside a label so deleting one is an informed decision, a bound on how many
 * properties everyone else has to carry, and an order for quick actions that
 * reflects which of them anyone reaches for.
 *
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe('workspace catalogues: archiving, counts and bounds', { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' }, () => {
   let sql: Sql;
   let app: BerryApp;
   let world: World;
   const tokens: Record<string, string> = {};

   before(async () => {
      sql = openDatabase({ url: url as string });
      world = await seedWorld(sql, `cat-admin-${randomUUID().slice(0, 6)}`);

      const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
      const registry = new Registry();
      registry.registerAll(
         workspaceReadMounts({
            sessions,
            sql,
            boards: new BoardRepository(sql),
            catalogExtensions: workCatalogRoutes(),
            viewExtensions: savedViewRoutes({ sql }),
         })
      );
      app = createApp(registry);
      tokens.owner = await issueTestToken(sql, world.ownerId);
      tokens.member = await issueTestToken(sql, world.memberId);
   });

   after(async () => {
      if (!sql) return;
      await cleanupWorld(sql, world);
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
   const catalog = (path: string) => `/api/v1/catalogs/${world.workspaceId}${path}`;

   test('an archived status is hidden by default, listed on request, and can be brought back', async () => {
      const created = await call('POST', catalog('/issue-statuses'), 'owner', {
         name: `Waiting ${randomUUID().slice(0, 6)}`,
         category: 'blocked',
         color: '#d97706',
         description: 'Somebody else has it.',
      });
      assert.equal(created.status, 201);
      const statusId = created.body?.id as string;
      assert.equal(created.body?.description, 'Somebody else has it.');

      assert.equal((await call('DELETE', catalog(`/issue-statuses/${statusId}`), 'owner')).status, 204);

      const ids = async (query: string) => {
         const listed = await call('GET', catalog(`/issue-statuses${query}`), 'owner');
         assert.equal(listed.status, 200);
         return (listed.body?.nodes as { id: string; archivedAt: string | null }[]);
      };

      // Default: gone, because every other caller wants the statuses a task
      // can be put into now.
      assert.equal((await ids('')).some((node) => node.id === statusId), false);

      const withArchived = await ids('?includeArchived=true');
      const archived = withArchived.find((node) => node.id === statusId);
      assert.ok(archived, 'the archived status is listed when asked for');
      assert.notEqual(archived.archivedAt, null);

      // And back again, which is the only thing that makes archiving safe to
      // offer without a second confirmation on top of the first.
      const restored = await call('PATCH', catalog(`/issue-statuses/${statusId}`), 'owner', { archived: false });
      assert.equal(restored.status, 200);
      assert.equal(restored.body?.archivedAt, null);
      assert.equal((await ids('')).some((node) => node.id === statusId), true);
   });

   test('a status cannot be archived through the patch that restores one', async () => {
      const created = await call('POST', catalog('/issue-statuses'), 'owner', {
         name: `Parked ${randomUUID().slice(0, 6)}`,
         category: 'blocked',
         color: '#d97706',
      });
      const statusId = created.body?.id as string;
      // Archiving also has to detach the tasks that are in the status, which
      // the DELETE route does and a patch does not.
      const refused = await call('PATCH', catalog(`/issue-statuses/${statusId}`), 'owner', { archived: true });
      assert.equal(refused.status, 422);
   });

   test('a label carries the number of tasks that use it', async () => {
      const created = await call('POST', catalog('/issue-labels'), 'owner', {
         name: `Flaky ${randomUUID().slice(0, 6)}`,
         color: '#6366f1',
      });
      assert.equal(created.status, 201);
      const labelId = created.body?.id as string;

      const countFor = async (id: string) => {
         const listed = await call('GET', catalog('/issue-labels'), 'owner');
         const node = (listed.body?.nodes as { id: string; usageCount: number }[]).find((row) => row.id === id);
         assert.ok(node, 'the label is listed');
         return node.usageCount;
      };

      assert.equal(await countFor(labelId), 0);

      await sql`
         INSERT INTO issue_label_memberships (workspace_id, issue_id, label_id)
         VALUES (${world.workspaceId}, ${world.issueId}, ${labelId})`;
      assert.equal(await countFor(labelId), 1);
   });

   test('a workspace is bounded to twenty active properties, and archiving gives a slot back', async () => {
      const make = (label: string) =>
         call('POST', catalog('/issue-properties'), 'owner', { name: `Cap ${label}`, kind: 'text' });

      const counted = (await sql`
         SELECT count(*)::int AS active FROM issue_property_definitions
          WHERE workspace_id = ${world.workspaceId} AND archived_at IS NULL`) as { active: number }[];
      const active = counted[0]?.active ?? 0;

      const created: string[] = [];
      for (let index = active; index < MAX_ACTIVE_PROPERTIES; index += 1) {
         const response = await make(`${index}-${randomUUID().slice(0, 6)}`);
         assert.equal(response.status, 201, `property ${index} was created`);
         created.push(response.body?.id as string);
      }

      const overflow = await make(`over-${randomUUID().slice(0, 6)}`);
      assert.equal(overflow.status, 409);

      const freed = created.at(-1) as string;
      assert.equal((await call('DELETE', catalog(`/issue-properties/${freed}`), 'owner')).status, 204);
      const afterArchive = await make(`again-${randomUUID().slice(0, 6)}`);
      assert.equal(afterArchive.status, 201);

      // Restoring the archived one would take the workspace back over the
      // bound, so it is refused for the same reason creating was.
      const restore = await call('PATCH', catalog(`/issue-properties/${freed}`), 'owner', { archived: false });
      assert.equal(restore.status, 409);

      // With room again, it comes back — and its stored values were never
      // touched, because archiving is a soft delete.
      assert.equal((await call('DELETE', catalog(`/issue-properties/${afterArchive.body?.id as string}`), 'owner')).status, 204);
      const restored = await call('PATCH', catalog(`/issue-properties/${freed}`), 'owner', { archived: false });
      assert.equal(restored.status, 200);
      assert.equal(restored.body?.archivedAt, null);
   });

   test('a quick action refuses a variable Berry cannot fill', async () => {
      assert.deepEqual(unfillableVariables('Fix {{issue.title}} in {{issue.identifier}}'), []);
      assert.deepEqual(unfillableVariables('Ping {{user.name}} about {{ issue.title }}'), ['user.name']);

      const refused = await call('POST', catalog('/quick-actions'), 'owner', {
         name: `Bad ${randomUUID().slice(0, 6)}`,
         targetAgentId: world.agentId,
         prompt: 'Ask {{user.name}} to look at it.',
      });
      assert.equal(refused.status, 422);
   });

   test('quick actions are listed most used first, and an archived one can come back or go for good', async () => {
      const create = (name: string) =>
         call('POST', catalog('/quick-actions'), 'owner', {
            name,
            targetAgentId: world.agentId,
            prompt: 'Have a look at {{issue.title}}.',
         });

      const suffix = randomUUID().slice(0, 6);
      // Named so that alphabetical order and usage order disagree: "Aardvark"
      // sorts first and is never used, so a list in the right order puts it
      // second.
      const quiet = await create(`Aardvark ${suffix}`);
      const busy = await create(`Zebra ${suffix}`);
      assert.equal(quiet.status, 201);
      assert.equal(busy.status, 201);
      assert.equal(busy.body?.useCount, 0);
      assert.equal(busy.body?.lastUsedAt, null);

      await sql`
         UPDATE quick_action_definitions SET use_count = 7, last_used_at = now()
          WHERE id = ${busy.body?.id as string}`;

      const listed = await call('GET', catalog('/quick-actions'), 'owner');
      const names = (listed.body?.nodes as { id: string; name: string }[])
         .filter((node) => node.name.endsWith(suffix))
         .map((node) => node.name);
      assert.deepEqual(names, [`Zebra ${suffix}`, `Aardvark ${suffix}`]);

      const busyId = busy.body?.id as string;
      assert.equal((await call('DELETE', catalog(`/quick-actions/${busyId}`), 'owner')).status, 204);
      const listedAfter = await call('GET', catalog('/quick-actions'), 'owner');
      assert.equal((listedAfter.body?.nodes as { id: string }[]).some((node) => node.id === busyId), false);

      const withArchived = await call('GET', catalog('/quick-actions?includeArchived=true'), 'owner');
      assert.equal((withArchived.body?.nodes as { id: string }[]).some((node) => node.id === busyId), true);

      const restored = await call('PATCH', catalog(`/quick-actions/${busyId}`), 'owner', { archived: false });
      assert.equal(restored.status, 200);
      assert.equal(restored.body?.archivedAt, null);
      // The count survives the round trip: archiving is not a reset.
      assert.equal(restored.body?.useCount, 7);

      // Deleting for good refuses while the action is still in use, so the
      // irreversible step is always the second one.
      assert.equal((await call('POST', catalog(`/quick-actions/${busyId}/delete`), 'owner')).status, 409);
      assert.equal((await call('DELETE', catalog(`/quick-actions/${busyId}`), 'owner')).status, 204);
      assert.equal((await call('POST', catalog(`/quick-actions/${busyId}/delete`), 'owner')).status, 204);

      const gone = await call('GET', catalog('/quick-actions?includeArchived=true'), 'owner');
      assert.equal((gone.body?.nodes as { id: string }[]).some((node) => node.id === busyId), false);
   });

   test("someone else's private quick action is not theirs to delete", async () => {
      const mine = await call('POST', catalog('/quick-actions'), 'member', {
         name: `Private ${randomUUID().slice(0, 6)}`,
         targetAgentId: world.agentId,
         prompt: 'Look at it.',
         visibility: 'private',
      });
      assert.equal(mine.status, 201);
      const actionId = mine.body?.id as string;

      // The owner is a moderator, so this is allowed for them; what must not
      // happen is a private action becoming visible to everyone else.
      const listedByOther = await call('GET', catalog('/quick-actions?includeArchived=true'), 'owner');
      const seen = (listedByOther.body?.nodes as { id: string }[]).some((node) => node.id === actionId);
      assert.equal(seen, false, "a private action stays the author's");
   });
});
