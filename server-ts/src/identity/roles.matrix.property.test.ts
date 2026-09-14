// Feature: auth-and-tenant-isolation, Property 4: Authorization grants exactly
// the role-permission matrix.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { Forbidden } from './errors.ts';
import { allows, PERMISSIONS, ROLES } from './roles.ts';
import { scopedDb, type WorkspaceContext } from './workspace-context.ts';
import { insertBoard } from '../test-support/boards.ts';
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
 * The property: `ScopedDb.mutate(required, work)` is the single RBAC gate for a
 * workspace-scoped write, and it permits the write *if and only if*
 * `allows(ctx.role, required)` is true. This test makes that equivalence
 * observable across the whole matrix. For each generated role — every value in
 * `ROLES` plus corrupt strings outside the vocabulary — paired with each
 * permission, it invokes `mutate` with a `work` that performs a real, reversible
 * write against a seeded `boards` row and asserts:
 *
 *   - the mutate outcome equals `allows(role, permission)`;
 *   - on allow, `work` ran and the row changed;
 *   - on deny, it threw {@link Forbidden} (→ `FORBIDDEN`) and a pre/post row
 *     snapshot is EQUAL — nothing was written.
 *
 * A corrupt role satisfies no permission (`allows` returns false for an unknown
 * role), so every corrupt row must be a denial with an unchanged snapshot. The
 * caller's role is taken from the confirmed {@link WorkspaceContext}, so the
 * context is constructed directly here rather than round-tripped through the
 * membership enum — the DB column is constrained to the valid vocabulary and
 * could never carry a corrupt value, which is exactly the value the matrix must
 * refuse (Requirements 7.2, 7.3, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7).
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration runs a real read + gated write against Postgres, so hold the
// run at the ≥100 floor the property suite requires.
const RUNS = 100;

/** Role strings outside the `owner|admin|member|viewer` vocabulary. */
const CORRUPT_ROLES = ['superadmin', 'root', 'god', 'OWNER', 'Admin', ''] as const;

describe(
   'Feature: auth-and-tenant-isolation, Property 4: Authorization grants exactly the role-permission matrix',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;

      const fixture: Record<string, string> = {};
      // The name the board is seeded with and restored to between iterations —
      // the baseline every pre/post snapshot is compared against.
      const BASELINE_NAME = 'Matrix baseline';

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);

         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`roles-prop4-${suffix}@berry.test`}, 'Roles Property 4')
            RETURNING id`;
         fixture.userId = user!.id as string;

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Matrix ${suffix}`}, ${`matrix-${suffix}`},
                    ${sql.json({ issuePrefix: 'MTX', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.userId})
            RETURNING id`;
         fixture.workspaceId = workspace!.id as string;

         // A board owned by the workspace: `work` renames it, so its `name` is
         // the pre/post snapshot the oracle compares.
         fixture.boardId = await insertBoard(sql, {
            workspaceId: fixture.workspaceId,
            createdBy: fixture.userId,
            name: BASELINE_NAME,
            // Board slugs are at most 12 characters (boards_slug_format_ck).
            slug: `mtx-${suffix}`,
         });
      });

      after(async () => {
         if (fixture.workspaceId) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. The shared helper clears and
            // deletes it inside one transaction.
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
            await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
            await sql`DELETE FROM boards WHERE workspace_id = ${fixture.workspaceId}`;
            await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
            await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
         }
         if (fixture.userId) await sql`DELETE FROM users WHERE id = ${fixture.userId}`;
         await closeDatabase(sql);
      });

      test(
         'Feature: auth-and-tenant-isolation, Property 4: mutate permits a write iff allows(role, permission); a denial is FORBIDDEN with an equal pre/post snapshot',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  // The Cartesian product of ROLES ∪ {corrupt} × PERMISSIONS.
                  // Corrupt roles (unknown vocabulary) grant nothing.
                  fc.oneof(
                     fc.constantFrom(...ROLES),
                     fc.constantFrom(...CORRUPT_ROLES),
                     fc.string({ maxLength: 24 })
                  ),
                  fc.constantFrom(...PERMISSIONS),
                  async (role, permission) => {
                     // The oracle: the matrix decides, and the confirmed context
                     // carries the role. `mutate` must agree with `allows`.
                     const expected = allows(role, permission);

                     const ctx: WorkspaceContext = {
                        workspaceId: fixture.workspaceId!,
                        userId: fixture.userId!,
                        role,
                     };
                     const db = scopedDb(sql, ctx);

                     // The pre snapshot: the board's stored name before the gate.
                     const [pre] = await sql`
                        SELECT name FROM boards WHERE id = ${fixture.boardId!}`;
                     const preName = pre!.name as string;

                     // A distinct name so a write is detectable. `work` performs
                     // a real, in-scope mutation inside mutate's transaction.
                     const nextName = `matrix-${randomUUID().slice(0, 12)}`;

                     let permitted: boolean;
                     try {
                        await db.mutate(permission, async (tx) => {
                           await tx`
                              UPDATE boards
                                 SET name = ${nextName}
                               WHERE id = ${fixture.boardId!}
                                 AND workspace_id = ${ctx.workspaceId}`;
                        });
                        permitted = true;
                     } catch (error) {
                        // The only expected rejection is the RBAC gate: a denial
                        // must be Forbidden, which maps to `FORBIDDEN` on the wire.
                        assert.ok(
                           error instanceof Forbidden,
                           `a denial must be Forbidden (→ FORBIDDEN), got: ${String(error)}`
                        );
                        permitted = false;
                     }

                     // The decision equals the matrix, for every role including
                     // corrupt ones.
                     assert.equal(
                        permitted,
                        expected,
                        `mutate decision must equal allows(${JSON.stringify(role)}, ${permission})`
                     );

                     // The post snapshot: what the row holds after the gate.
                     const [post] = await sql`
                        SELECT name FROM boards WHERE id = ${fixture.boardId!}`;
                     const postName = post!.name as string;

                     if (expected) {
                        // An allow ran `work`: the row changed to the new name.
                        assert.equal(
                           postName,
                           nextName,
                           'an allowed mutate must have performed the write'
                        );
                     } else {
                        // A denial wrote nothing: the pre/post snapshot is EQUAL.
                        assert.equal(
                           postName,
                           preName,
                           'a denied mutate must leave an equal pre/post snapshot (no write)'
                        );
                     }

                     // Restore the baseline so each iteration starts from the
                     // same pre snapshot regardless of the previous outcome.
                     await sql`
                        UPDATE boards SET name = ${BASELINE_NAME} WHERE id = ${fixture.boardId!}`;
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
