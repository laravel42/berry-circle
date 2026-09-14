// Feature: auth-and-tenant-isolation, Property 3: Cross-workspace and
// non-existent resources are indistinguishably absent.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { workspaceReadMounts } from './workspace-reads.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';

/**
 * Database-backed property test, gated the way the rest of the server suite
 * gates its own: `BERRY_TEST_DATABASE_URL` against a database carrying the real
 * migrations. Without it this self-skips, so a fresh `pnpm test:server` stays
 * green offline.
 *
 *   createdb berry_ts_test
 *   psql berry_ts_test < <(pg_dump --schema-only berry)
 *   BERRY_TEST_DATABASE_URL=postgres://... pnpm test:server
 *
 * The property: a resource the caller cannot reach is *indistinguishably*
 * absent. A caller who is a member of W1 but not of W2 either (a) names a
 * resource that actually lives in W2, or (b) names a random uuid that names no
 * resource anywhere. Both are driven end-to-end through the real mount, and
 * both must come back byte-identical — same 404 status, same envelope body,
 * same observable headers — and neither may alter a single stored row. If the
 * W2 case answered differently from the pure-nonsense case, that difference
 * would be an oracle telling the caller which ids exist across the tenant
 * boundary (Requirements 5.5, 5.6, 6.2, 6.3, 7.1).
 *
 * It exercises both a read path and a mutation path:
 *   - read:     GET   /api/v1/catalogs/{scope}/issue-labels — {scope} is W2
 *               (a workspace the caller is not a member of) versus a random
 *               non-existent workspace uuid.
 *   - mutation: PATCH /api/v1/catalogs/{W1}/issue-labels/{labelId} — {labelId}
 *               is a label stored in W2 versus a random non-existent uuid,
 *               resolved under the caller's confirmed W1 scope.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration drives real HTTP requests through the app against Postgres, so
// hold the run at the ≥100 floor the property suite requires.
const RUNS = 100;

// A client-supplied correlation id is echoed verbatim by the app when it is
// safe (isValidRequestId), and it is the one per-request-random field in the
// error envelope (`requestId`) and the `x-request-id` header. Pinning it to the
// same value on both compared requests removes that noise, so any remaining
// difference between the two 404s is a real cross-tenant oracle rather than a
// fresh id. The request id is caller-controlled correlation, not a signal about
// the resource.
const FIXED_REQUEST_ID = 'req_property3indistinguishability';

/** Build the real app with just the workspace-read mounts on the live database. */
function buildApp(sql: Sql) {
   const sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
   const boards = new BoardRepository(sql);
   const registry = new Registry();
   registry.registerAll(workspaceReadMounts({ sessions, sql, boards }));
   return { app: createApp(registry) };
}

/** The response facets Property 3 compares: status, exact body bytes, headers. */
async function snapshot(response: Response) {
   const headers = [...response.headers.entries()]
      .map(([name, value]) => [name.toLowerCase(), value] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
   return {
      status: response.status,
      body: await response.text(),
      headers,
   };
}

/** A snapshot of the rows a probe might touch, ordered for a stable compare. */
async function labelRows(sql: Sql, workspaceIds: string[]) {
   const rows = await sql`
      SELECT id, workspace_id, name, description, color, created_at, updated_at, archived_at
        FROM issue_labels
       WHERE workspace_id = ANY(${sql.array(workspaceIds)}::uuid[])
       ORDER BY id`;
   return JSON.stringify(rows);
}

describe(
   'Feature: auth-and-tenant-isolation, Property 3: Cross-workspace and non-existent resources are indistinguishably absent',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: ReturnType<typeof buildApp>['app'];

      // The seeded truth. The caller is a member of `w1Id` (which owns
      // `w1LabelId`), and is NOT a member of `w2Id` (which owns `w2LabelId`).
      const fixture: Record<string, string> = {};
      // A personal access token for the caller (the same bearer path an API
      // client uses), sent as `Authorization: Bearer`.
      let token: string;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);

         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`absent-prop3-${suffix}@berry.test`}, 'Absent Property 3')
            RETURNING id`;
         fixture.userId = user!.id as string;

         // W1: the workspace the caller belongs to.
         const [w1] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`W1 ${suffix}`}, ${`w1-${suffix}`},
                    ${sql.json({ issuePrefix: 'AAA', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.userId})
            RETURNING id`;
         fixture.w1Id = w1!.id as string;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${fixture.w1Id}, ${fixture.userId}, 'member')`;

         // W2: a workspace the caller is NOT a member of.
         const [w2] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`W2 ${suffix}`}, ${`w2-${suffix}`},
                    ${sql.json({ issuePrefix: 'BBB', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.userId})
            RETURNING id`;
         fixture.w2Id = w2!.id as string;

         // A label in each workspace. The W2 label is the cross-workspace
         // resource whose existence must never leak through the W1 scope.
         const [w1Label] = await sql`
            INSERT INTO issue_labels (workspace_id, name, color, created_by)
            VALUES (${fixture.w1Id}, 'w1-label', '#6366f1', ${fixture.userId})
            RETURNING id`;
         fixture.w1LabelId = w1Label!.id as string;

         const [w2Label] = await sql`
            INSERT INTO issue_labels (workspace_id, name, color, created_by)
            VALUES (${fixture.w2Id}, 'w2-label', '#6366f1', ${fixture.userId})
            RETURNING id`;
         fixture.w2LabelId = w2Label!.id as string;

         const built = buildApp(sql);
         app = built.app;
         // Mint the caller's credential. Assigned to the suite-level `token`
         // every request reads, never shadowed.
         token = await issueTestToken(sql, fixture.userId);

         // Positive control: the caller can read its own workspace. Without it
         // a broken credential would turn every probe into the same 401 and
         // the indistinguishability property would pass vacuously.
         const own = await app.request(`/api/v1/catalogs/${fixture.w1Id}/issue-labels`, {
            headers: { authorization: `Bearer ${token}`, 'x-request-id': FIXED_REQUEST_ID },
         });
         assert.equal(own.status, 200, 'the caller reads its own workspace');
      });

      after(async () => {
         if (fixture.w1Id || fixture.w2Id) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. The shared helper clears and
            // deletes it inside one transaction.
            for (const ws of [fixture.w1Id, fixture.w2Id]) {
               if (!ws) continue;
               await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM issue_labels WHERE workspace_id = ${ws}`;
               await deleteWorkspaceAgents(sql, [ws]);
               await deleteWorkspaceBoards(sql, [ws]);
               await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspaces WHERE id = ${ws}`;
            }
         }
         if (fixture.userId) {
            await sql`DELETE FROM sessions WHERE user_id = ${fixture.userId}`;
            await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
         }
         await closeDatabase(sql);
      });

      test(
         'Feature: auth-and-tenant-isolation, Property 3: a cross-workspace resource and a random non-existent uuid yield byte-identical 404 envelopes on both a read and a mutation, and leave stored rows unchanged',
         async () => {
            const authHeaders: Record<string, string> = {
               authorization: `Bearer ${token}`,
               'x-request-id': FIXED_REQUEST_ID,
            };

            await fc.assert(
               fc.asyncProperty(
                  // A random non-existent workspace uuid for the read probe, and
                  // a random non-existent label uuid for the mutation probe. Each
                  // is overwhelmingly unlikely to name any real row, and neither
                  // is the caller's confirmed scope.
                  fc.uuid(),
                  fc.uuid(),
                  // A random patch body: whatever is sent, a resource the caller
                  // cannot reach must 404 before any column is touched.
                  fc.record({
                     name: fc.string({ minLength: 1, maxLength: 40 }),
                     color: fc.constantFrom('#123456', '#abcdef', '#0f0f0f'),
                  }),
                  async (absentWorkspaceId, absentLabelId, patch) => {
                     // The full stored state before any probe runs.
                     const before = await labelRows(sql, [fixture.w1Id!, fixture.w2Id!]);

                     // --- Read path -------------------------------------------
                     // Naming W2 (a workspace the caller is not a member of)
                     // versus a random non-existent workspace uuid. Both are a
                     // lookup key the resolver refuses before any row is read.
                     const readCross = await snapshot(
                        await app.request(
                           `/api/v1/catalogs/${fixture.w2Id}/issue-labels`,
                           { headers: authHeaders }
                        )
                     );
                     const readAbsent = await snapshot(
                        await app.request(
                           `/api/v1/catalogs/${absentWorkspaceId}/issue-labels`,
                           { headers: authHeaders }
                        )
                     );

                     assert.equal(readCross.status, 404, 'a non-member workspace read must be 404');
                     assert.equal(readAbsent.status, 404, 'an absent workspace read must be 404');
                     assert.deepEqual(
                        readCross,
                        readAbsent,
                        'reading a non-member workspace and an absent workspace must be ' +
                           'indistinguishable (same status, body bytes, and headers)'
                     );

                     // --- Mutation path ---------------------------------------
                     // Under the caller's confirmed W1 scope, PATCH a label that
                     // actually lives in W2 versus a random non-existent label
                     // uuid. Both resolve to NotFound against W1 and must never
                     // touch a row.
                     const patchCross = await snapshot(
                        await app.request(
                           `/api/v1/catalogs/${fixture.w1Id}/issue-labels/${fixture.w2LabelId}`,
                           {
                              method: 'PATCH',
                              headers: { ...authHeaders, 'content-type': 'application/json' },
                              body: JSON.stringify(patch),
                           }
                        )
                     );
                     const patchAbsent = await snapshot(
                        await app.request(
                           `/api/v1/catalogs/${fixture.w1Id}/issue-labels/${absentLabelId}`,
                           {
                              method: 'PATCH',
                              headers: { ...authHeaders, 'content-type': 'application/json' },
                              body: JSON.stringify(patch),
                           }
                        )
                     );

                     assert.equal(patchCross.status, 404, 'patching a W2 label under W1 must be 404');
                     assert.equal(patchAbsent.status, 404, 'patching an absent label must be 404');
                     assert.deepEqual(
                        patchCross,
                        patchAbsent,
                        'patching a cross-workspace label and an absent label must be ' +
                           'indistinguishable (same status, body bytes, and headers)'
                     );

                     // No probe — read or mutation — may alter stored data.
                     const afterState = await labelRows(sql, [fixture.w1Id!, fixture.w2Id!]);
                     assert.equal(
                        afterState,
                        before,
                        'a probing read or mutation must leave every stored row unchanged'
                     );
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
