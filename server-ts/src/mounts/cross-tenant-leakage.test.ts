// Feature: auth-and-tenant-isolation, cross-tenant leakage tests (task 6.5).
//
// The four security guarantees, asserted against a hand-built two-workspace
// world rather than a randomized one. The properties (P2, P3, P4, P5) carry the
// universal statements; these explicit examples document the guarantees at a
// glance and guard against a generator that never happens to produce the
// adversarial two-workspace case (design §"Cross-tenant leakage tests").
//
// The world: workspace W1 with member U1, workspace W2 with member U2. U1 is
// NOT a member of W2. Each workspace carries identifiable rows — an issue
// label, a saved view, a board, and (auto-seeded by the workspace-insert
// trigger) issue statuses. Every request below is driven through the real app
// shell with U1's personal access token (the same bearer path an API client
// uses), so the error envelope, request id, and
// standard headers are exactly what a client would receive.
//
// The four guarantees:
//   (a) U1 listing/searching under W1 never sees a W2 row.
//   (b) U1 GET-ing a W2 resource gets the same 404 as a random uuid.
//   (c) U1 mutating a W2 resource gets 404 and W2 is unchanged.
//   (d) An unauthenticated caller is rejected before any handler runs.
//
// DB-backed and gated the way the rest of the suite gates itself:
// `BERRY_TEST_DATABASE_URL` against a database carrying the real migrations.
// Without it this self-skips, so a fresh `pnpm test:server` stays green
// offline (Requirements 6.2, 6.3, 7.1, 4.1).

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
import { workspaceReadMounts } from './workspace-reads.ts';

const url = process.env.BERRY_TEST_DATABASE_URL;

// A fixed request id, set on every request, so the 404 envelopes compared in
// guarantee (b) are byte-for-byte comparable rather than carrying a fresh
// random id each time.
const REQUEST_ID = 'req_' + 'a'.repeat(32);

/** A random uuid that names no workspace at all — the control for guarantee (b). */
const RANDOM_WORKSPACE = randomUUID();

interface World {
   u1Token: string;
   w1Id: string;
   w2Id: string;
   w1LabelId: string;
   w2LabelId: string;
   w1LabelName: string;
   w2LabelName: string;
   w1ViewId: string;
   w2ViewId: string;
   w1ViewName: string;
   w2ViewName: string;
   w1BoardId: string;
   w2BoardId: string;
   w1BoardName: string;
   w2BoardName: string;
   userIds: string[];
   workspaceIds: string[];
}

describe(
   'Feature: auth-and-tenant-isolation, cross-tenant leakage (explicit two-workspace guarantees)',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      const world = {} as World;

      before(async () => {
         sql = openDatabase({ url: url as string });

         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         const boards = new BoardRepository(sql);
         const registry = new Registry();
         registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
         app = createApp(registry);

         const suffix = randomUUID().slice(0, 8);

         // Two users. U1 will be the caller; U2 exists only to own W2's rows so
         // W2 is a genuine, populated tenant rather than an empty one.
         const [u1] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`leak-u1-${suffix}@berry.test`}, 'Leakage U1')
            RETURNING id`;
         const [u2] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`leak-u2-${suffix}@berry.test`}, 'Leakage U2')
            RETURNING id`;
         const u1Id = u1!.id as string;
         const u2Id = u2!.id as string;
         world.userIds = [u1Id, u2Id];

         // Two workspaces. Inserting each fires the trigger that seeds its issue
         // statuses, so both tenants carry a full status vocabulary.
         const [w1] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`W1 ${suffix}`}, ${`w1-${suffix}`},
                    ${sql.json({ issuePrefix: 'W1X', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${u1Id})
            RETURNING id`;
         const [w2] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`W2 ${suffix}`}, ${`w2-${suffix}`},
                    ${sql.json({ issuePrefix: 'W2X', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${u2Id})
            RETURNING id`;
         world.w1Id = w1!.id as string;
         world.w2Id = w2!.id as string;
         world.workspaceIds = [world.w1Id, world.w2Id];

         // Memberships. U1 is an owner of W1 (so it may both read and write),
         // and — critically — is NOT a member of W2. U2 owns W2.
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${world.w1Id}, ${u1Id}, 'owner')`;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${world.w2Id}, ${u2Id}, 'owner')`;

         // Identifiable labels in each workspace. The names are distinct and
         // searchable so a leak would be visible by name, not only by id.
         world.w1LabelName = `w1-label-${suffix}`;
         world.w2LabelName = `w2-label-${suffix}`;
         const [w1Label] = await sql`
            INSERT INTO issue_labels (workspace_id, name, color, created_by)
            VALUES (${world.w1Id}, ${world.w1LabelName}, '#111111', ${u1Id})
            RETURNING id`;
         const [w2Label] = await sql`
            INSERT INTO issue_labels (workspace_id, name, color, created_by)
            VALUES (${world.w2Id}, ${world.w2LabelName}, '#222222', ${u2Id})
            RETURNING id`;
         world.w1LabelId = w1Label!.id as string;
         world.w2LabelId = w2Label!.id as string;

         // Identifiable saved views in each workspace, visibility 'workspace'
         // so they would list for any member of their own workspace.
         world.w1ViewName = `w1-view-${suffix}`;
         world.w2ViewName = `w2-view-${suffix}`;
         const [w1View] = await sql`
            INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query)
            VALUES (${world.w1Id}, ${u1Id}, ${world.w1ViewName}, 'workspace', ${sql.json({} as never)})
            RETURNING id`;
         const [w2View] = await sql`
            INSERT INTO saved_issue_views (workspace_id, owner_id, name, visibility, query)
            VALUES (${world.w2Id}, ${u2Id}, ${world.w2ViewName}, 'workspace', ${sql.json({} as never)})
            RETURNING id`;
         world.w1ViewId = w1View!.id as string;
         world.w2ViewId = w2View!.id as string;

         // Identifiable boards. `/search?types=board` matches board names, so a
         // W2 board leaking into a W1 search would show by name.
         world.w1BoardName = `w1-board-${suffix}`;
         world.w2BoardName = `w2-board-${suffix}`;
         const [w1Board] = await sql`
            INSERT INTO boards (id, workspace_id, name, slug, created_by)
            VALUES (${randomUUID()}, ${world.w1Id}, ${world.w1BoardName}, ${`w1b-${suffix}`}, ${u1Id})
            RETURNING id`;
         const [w2Board] = await sql`
            INSERT INTO boards (id, workspace_id, name, slug, created_by)
            VALUES (${randomUUID()}, ${world.w2Id}, ${world.w2BoardName}, ${`w2b-${suffix}`}, ${u2Id})
            RETURNING id`;
         world.w1BoardId = w1Board!.id as string;
         world.w2BoardId = w2Board!.id as string;

         // A real personal access token for U1 (the same bearer path an API
         // client uses); every authenticated request below carries it.
         world.u1Token = await issueTestToken(sql, u1Id);
      });

      after(async () => {
         if (!sql) return;
         if (world.workspaceIds?.length) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. Suspend the guard for the
            // fixture's own teardown, then restore it.
            await sql`ALTER TABLE agents DISABLE TRIGGER berry_agents_block_protected_delete`;
            try {
               for (const ws of world.workspaceIds) {
                  await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM agents WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM saved_issue_views WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM issue_labels WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM issue_status_definitions WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM boards WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
                  await sql`DELETE FROM workspaces WHERE id = ${ws}`;
               }
            } finally {
               await sql`ALTER TABLE agents ENABLE TRIGGER berry_agents_block_protected_delete`;
            }
         }
         if (world.userIds?.length) {
            // Sessions cascade on user delete (ON DELETE CASCADE), so removing
            // the users clears the seeded session too.
            for (const uid of world.userIds) {
               await sql`DELETE FROM users WHERE id = ${uid}`;
            }
         }
         await closeDatabase(sql);
      });

      /** Authenticated GET as U1, with the fixed request id. */
      function getAsU1(path: string): Promise<Response> {
         return Promise.resolve(
            app.request(path, {
               headers: {
                  authorization: `Bearer ${world.u1Token}`,
                  'x-request-id': REQUEST_ID,
               },
            })
         );
      }

      /** Authenticated PATCH as U1 with a JSON body and the fixed request id. */
      function patchAsU1(path: string, body: unknown): Promise<Response> {
         return Promise.resolve(
            app.request(path, {
               method: 'PATCH',
               headers: {
                  authorization: `Bearer ${world.u1Token}`,
                  'content-type': 'application/json',
                  'x-request-id': REQUEST_ID,
               },
               body: JSON.stringify(body),
            })
         );
      }

      // -------------------------------------------------------- guarantee (a)

      test(
         'guarantee (a): a W1 member listing and searching never sees a W2 row',
         async () => {
            // Catalog labels under W1: only W1's label, never W2's.
            const labels = (await (await getAsU1(
               `/api/v1/catalogs/${world.w1Id}/issue-labels`
            )).json()) as { nodes: Array<{ id: string; name: string }> };
            const labelIds = labels.nodes.map((n) => n.id);
            const labelNames = labels.nodes.map((n) => n.name);
            assert.ok(labelIds.includes(world.w1LabelId), 'W1 label should be listed under W1');
            assert.ok(!labelIds.includes(world.w2LabelId), 'W2 label id must not appear under W1');
            assert.ok(!labelNames.includes(world.w2LabelName), 'W2 label name must not appear under W1');

            // Issue statuses under W1: never a status belonging to W2.
            const statuses = (await (await getAsU1(
               `/api/v1/catalogs/${world.w1Id}/issue-statuses`
            )).json()) as { nodes: Array<{ id: string }> };
            const w2StatusIds = (
               await sql`SELECT id FROM issue_status_definitions WHERE workspace_id = ${world.w2Id}`
            ).map((r) => r.id as string);
            for (const node of statuses.nodes) {
               assert.ok(
                  !w2StatusIds.includes(node.id),
                  'a W2 status id must not appear under W1'
               );
            }

            // Saved views under W1: only W1's view, never W2's.
            const views = (await (await getAsU1(
               `/api/v1/views?workspaceId=${world.w1Id}`
            )).json()) as { nodes: Array<{ id: string; name: string }> };
            const viewIds = views.nodes.map((n) => n.id);
            const viewNames = views.nodes.map((n) => n.name);
            assert.ok(viewIds.includes(world.w1ViewId), 'W1 view should be listed under W1');
            assert.ok(!viewIds.includes(world.w2ViewId), 'W2 view id must not appear under W1');
            assert.ok(!viewNames.includes(world.w2ViewName), 'W2 view name must not appear under W1');

            // Search under W1 for W2's board name: no W2 rows come back, even
            // though a board of that exact name exists in W2.
            const boardHit = (await (await getAsU1(
               `/api/v1/search?workspaceId=${world.w1Id}&types=board&query=${world.w2BoardName}`
            )).json()) as { nodes: Array<{ id: string; title: string }> };
            const boardIds = boardHit.nodes.map((n) => n.id);
            assert.ok(!boardIds.includes(world.w2BoardId), 'searching W1 must not surface a W2 board');
            assert.ok(
               !boardHit.nodes.some((n) => n.title === world.w2BoardName),
               'a W2 board name must not surface in a W1 search'
            );

            // And a positive control: the same search shape does find W1's own
            // board, so an empty result above is isolation, not a broken query.
            const ownBoard = (await (await getAsU1(
               `/api/v1/search?workspaceId=${world.w1Id}&types=board&query=${world.w1BoardName}`
            )).json()) as { nodes: Array<{ id: string }> };
            assert.ok(
               ownBoard.nodes.some((n) => n.id === world.w1BoardId),
               'a W1 board is found by a W1 search'
            );
         }
      );

      // -------------------------------------------------------- guarantee (b)

      test(
         'guarantee (b): a W1 member GET-ing a W2 resource gets the byte-identical 404 of a random uuid',
         async () => {
            // GET the W2 catalog scope as U1 (a non-member of W2).
            const foreign = await getAsU1(`/api/v1/catalogs/${world.w2Id}/issue-labels`);
            // GET a workspace scope that does not exist at all.
            const nonexistent = await getAsU1(
               `/api/v1/catalogs/${RANDOM_WORKSPACE}/issue-labels`
            );

            assert.equal(foreign.status, 404, 'a foreign workspace is 404');
            assert.equal(nonexistent.status, 404, 'a non-existent workspace is 404');

            // Byte-identical bodies: the two are indistinguishable, so U1 cannot
            // tell a workspace it is barred from from one that does not exist.
            assert.equal(
               await foreign.text(),
               await nonexistent.text(),
               'the foreign-workspace and random-uuid 404 bodies must be byte-identical'
            );

            // The observable headers match too (same fixed request id, same
            // error code header shape via the shared envelope).
            assert.equal(
               foreign.headers.get('x-request-id'),
               nonexistent.headers.get('x-request-id')
            );
            assert.equal(
               foreign.headers.get('content-type'),
               nonexistent.headers.get('content-type')
            );

            // The same indistinguishability holds when the W2 resource is named
            // by a concrete W2 label id under W1's own scope: a label owned by
            // W2 is as absent as a random uuid.
            const w2LabelUnderW1 = await getAsU1(
               `/api/v1/catalogs/${world.w1Id}/issue-labels`
            );
            // (labels list is covered in (a); here we exercise the id path via
            // a mutation-free GET is not offered for a single label, so the
            // single-resource 404 comparison is asserted through PATCH in (c).)
            assert.equal(w2LabelUnderW1.status, 200);
         }
      );

      // -------------------------------------------------------- guarantee (c)

      test(
         'guarantee (c): a W1 member mutating a W2 resource gets 404 and W2 is unchanged',
         async () => {
            // Snapshot W2's label row before the attempt.
            const [beforeRow] = await sql`
               SELECT name, color, updated_at
                 FROM issue_labels
                WHERE id = ${world.w2LabelId} AND workspace_id = ${world.w2Id}`;
            assert.ok(beforeRow, 'the W2 label exists before the attempt');

            // Attempt 1: PATCH the W2 label under the W2 scope. U1 is not a
            // member of W2, so the workspace-scope gate rejects it as 404
            // before the handler runs.
            const underW2 = await patchAsU1(
               `/api/v1/catalogs/${world.w2Id}/issue-labels/${world.w2LabelId}`,
               { name: 'hijacked-by-u1' }
            );
            assert.equal(underW2.status, 404, 'mutating a W2 label under W2 is 404 for a non-member');

            // Attempt 2: PATCH the W2 label id under U1's OWN W1 scope. Here the
            // scope resolves (U1 is a W1 owner), but the label belongs to W2, so
            // the scoped update matches no row and answers 404 — the id cannot
            // reach across the tenant boundary.
            const underW1 = await patchAsU1(
               `/api/v1/catalogs/${world.w1Id}/issue-labels/${world.w2LabelId}`,
               { name: 'hijacked-by-u1' }
            );
            assert.equal(underW1.status, 404, 'a W2 label id under the W1 scope is 404');

            // And that 404 is byte-identical to a genuinely non-existent label
            // id under the same W1 scope: the cross-tenant id is indistinguish-
            // able from a random one.
            const missingUnderW1 = await patchAsU1(
               `/api/v1/catalogs/${world.w1Id}/issue-labels/${randomUUID()}`,
               { name: 'hijacked-by-u1' }
            );
            assert.equal(missingUnderW1.status, 404);
            assert.equal(
               await underW1.text(),
               await missingUnderW1.text(),
               'a cross-tenant label id and a random label id yield byte-identical 404s'
            );

            // W2's row is exactly as it was: name, color, and updated_at all
            // unchanged, so neither attempt touched it.
            const [afterRow] = await sql`
               SELECT name, color, updated_at
                 FROM issue_labels
                WHERE id = ${world.w2LabelId} AND workspace_id = ${world.w2Id}`;
            assert.ok(afterRow, 'the W2 label still exists after the attempts');
            assert.equal(afterRow.name, beforeRow.name, 'W2 label name is unchanged');
            assert.equal(afterRow.color, beforeRow.color, 'W2 label color is unchanged');
            assert.equal(
               String(afterRow.updated_at),
               String(beforeRow.updated_at),
               'W2 label updated_at is unchanged (no write occurred)'
            );
         }
      );

      // -------------------------------------------------------- guarantee (d)

      test(
         'guarantee (d): an unauthenticated caller is rejected with 401 before any handler runs',
         async () => {
            // Snapshot W1's label row: an unauthenticated mutation attempt must
            // leave it untouched, which is the evidence the handler never ran.
            const [before] = await sql`
               SELECT name, color, updated_at
                 FROM issue_labels
                WHERE id = ${world.w1LabelId} AND workspace_id = ${world.w1Id}`;
            assert.ok(before, 'the W1 label exists before the attempt');

            const fixedId = (headers: Record<string, string>): Record<string, string> => ({
               ...headers,
               'x-request-id': REQUEST_ID,
            });

            // A read with no Authorization header at all.
            const noAuthRead = await Promise.resolve(
               app.request(`/api/v1/catalogs/${world.w1Id}/issue-labels`, {
                  headers: fixedId({}),
               })
            );
            assert.equal(noAuthRead.status, 401, 'an unauthenticated read is 401');

            // A read with a malformed Authorization header (wrong scheme).
            const wrongScheme = await Promise.resolve(
               app.request(`/api/v1/catalogs/${world.w1Id}/issue-labels`, {
                  headers: fixedId({ authorization: `Basic ${world.u1Token}` }),
               })
            );
            assert.equal(wrongScheme.status, 401, 'a wrong-scheme credential is 401');

            // A read with a well-formed but bogus bearer token.
            const bogusBearer = await Promise.resolve(
               app.request(`/api/v1/catalogs/${world.w1Id}/issue-labels`, {
                  headers: fixedId({ authorization: `Bearer ${'z'.repeat(43)}` }),
               })
            );
            assert.equal(bogusBearer.status, 401, 'a bogus bearer token is 401');

            // Every unauthenticated failure returns the byte-identical envelope.
            const bodies = await Promise.all([
               noAuthRead.text(),
               wrongScheme.text(),
               bogusBearer.text(),
            ]);
            assert.equal(bodies[0], bodies[1], 'no-auth and wrong-scheme envelopes match');
            assert.equal(bodies[0], bodies[2], 'no-auth and bogus-bearer envelopes match');
            const parsed = JSON.parse(bodies[0]) as { error: { code: string } };
            assert.equal(parsed.error.code, 'UNAUTHENTICATED');

            // An unauthenticated MUTATION: the handler that would touch the row
            // must never run, so the row is unchanged afterward — the standing
            // evidence that the gate fired before the handler.
            const noAuthWrite = await Promise.resolve(
               app.request(`/api/v1/catalogs/${world.w1Id}/issue-labels/${world.w1LabelId}`, {
                  method: 'PATCH',
                  headers: fixedId({ 'content-type': 'application/json' }),
                  body: JSON.stringify({ name: 'unauthenticated-write' }),
               })
            );
            assert.equal(noAuthWrite.status, 401, 'an unauthenticated write is 401');

            const [after] = await sql`
               SELECT name, color, updated_at
                 FROM issue_labels
                WHERE id = ${world.w1LabelId} AND workspace_id = ${world.w1Id}`;
            assert.ok(after, 'the W1 label still exists after the attempt');
            assert.equal(after.name, before.name, 'W1 label name is unchanged by an unauth write');
            assert.equal(after.color, before.color, 'W1 label color is unchanged by an unauth write');
            assert.equal(
               String(after.updated_at),
               String(before.updated_at),
               'W1 label updated_at is unchanged — the write handler never ran'
            );
         }
      );
   }
);
