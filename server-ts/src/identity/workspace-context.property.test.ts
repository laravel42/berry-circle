// Feature: auth-and-tenant-isolation, Property 5: Workspace context is
// server-derived and request claims are ignored.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from './errors.ts';
import { ROLES } from './roles.ts';
import { resolveWorkspaceContext, scopedDb } from './workspace-context.ts';
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
 * The property: `resolveWorkspaceContext` and `scopedDb` derive scope and role
 * from the database alone. The signatures take a session-resolved `userId` and
 * a *lookup* `workspaceId` — never a role and never a request-supplied
 * authorization claim. This test makes the guarantee observable by generating
 * adversarial claims (a different role string, a foreign `workspaceId`) as if
 * they arrived in the body, a header, or the query string, then asserting the
 * resolved context is unmoved: `ctx.role` equals the membership role recorded
 * in `workspace_memberships`, `ctx.workspaceId` equals the confirmed workspace,
 * and a resource resolves by its *stored* owning workspace. A claimed foreign
 * workspace the user is not a member of yields `NotFound`, never access
 * (Requirements 5.1, 5.2, 5.3).
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration runs real membership and resource lookups against Postgres, so
// hold the run at the ≥100 floor the property suite requires.
const RUNS = 100;

/** Where an adversarial claim was placed — purely descriptive for the test. */
const CLAIM_LOCATIONS = ['body', 'header', 'query'] as const;

describe(
   'Feature: auth-and-tenant-isolation, Property 5: Workspace context is server-derived and request claims are ignored',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;

      // The seeded truth. The user is a `member` of `workspaceId`, which owns
      // `boardId`. `otherWorkspaceId` exists but the user is NOT a member of it.
      const fixture: Record<string, string> = {};
      // The role recorded in workspace_memberships — the only role the resolved
      // context is ever allowed to carry.
      const TRUE_ROLE = 'member';

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);

         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`ctx-prop5-${suffix}@berry.test`}, 'Context Property 5')
            RETURNING id`;
         fixture.userId = user!.id as string;

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Ctx ${suffix}`}, ${`ctx-${suffix}`},
                    ${sql.json({ issuePrefix: 'CTX', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.userId})
            RETURNING id`;
         fixture.workspaceId = workspace!.id as string;

         // The membership row is the sole source of the caller's role. Seed it
         // as `member` so an injected `owner`/`admin`/`viewer` claim is always
         // a value the resolver must refuse to adopt.
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${fixture.workspaceId}, ${fixture.userId}, ${TRUE_ROLE})`;

         // A resource owned by the confirmed workspace: requireResource must
         // resolve it by its stored workspace_id, not a claimed one.
         fixture.boardId = await insertBoard(sql, {
            workspaceId: fixture.workspaceId,
            createdBy: fixture.userId,
            name: 'Ctx board',
            slug: `ctx-${suffix}`,
         });

         // A second workspace the user is NOT a member of. A claim naming it
         // must never grant the user access to it.
         // It belongs to someone else, who creates it and its board: a board's
         // creator must be an active member, and the user must stay outside it.
         const [otherOwner] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`ctx-prop5-other-${suffix}@berry.test`}, 'Context Property 5 other')
            RETURNING id`;
         fixture.otherOwnerId = otherOwner!.id as string;
         const [other] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Other ${suffix}`}, ${`other-${suffix}`},
                    ${sql.json({ issuePrefix: 'OTH', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.otherOwnerId})
            RETURNING id`;
         fixture.otherWorkspaceId = other!.id as string;

         // A resource owned by the OTHER workspace: it must be indistinguishable
         // from a non-existent id when looked up under the member's scope.
         fixture.otherBoardId = await insertBoard(sql, {
            workspaceId: fixture.otherWorkspaceId,
            createdBy: fixture.otherOwnerId,
            name: 'Other board',
            // Board slugs are at most 12 characters (boards_slug_format_ck).
            slug: `oth-${suffix}`,
         });
      });

      after(async () => {
         if (fixture.workspaceId || fixture.otherWorkspaceId) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. The shared helper clears and
            // deletes it inside one transaction.
            for (const ws of [fixture.workspaceId, fixture.otherWorkspaceId]) {
               if (!ws) continue;
               await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
               await deleteWorkspaceAgents(sql, [ws]);
               await sql`DELETE FROM boards WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspaces WHERE id = ${ws}`;
            }
         }
         for (const id of [fixture.userId, fixture.otherOwnerId]) {
            if (id) await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      test(
         'Feature: auth-and-tenant-isolation, Property 5: ctx.role is the DB membership role and ctx.workspaceId is the confirmed/stored workspace, regardless of injected role/workspaceId claims',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  // A fake role claim. Drawn from the real role vocabulary
                  // (including the privileged ones) plus arbitrary junk, but
                  // always different from the true membership role, so adopting
                  // it would be an observable privilege change.
                  fc
                     .oneof(
                        fc.constantFrom(...ROLES),
                        fc.constantFrom('superadmin', 'root', 'god', ''),
                        fc.string({ maxLength: 24 })
                     )
                     .filter((role) => role !== TRUE_ROLE),
                  // A fake workspaceId claim. Either the foreign workspace the
                  // user is not a member of, or a random uuid that names no
                  // workspace at all.
                  fc.oneof(
                     fc.constant(fixture.otherWorkspaceId as string),
                     fc.uuid()
                  ),
                  // Where the adversary pretended to place the claim. The
                  // resolver's signature has no parameter for any of these, so
                  // the location is only documentation for the assertion.
                  fc.constantFrom(...CLAIM_LOCATIONS),
                  async (fakeRole, fakeWorkspaceId, location) => {
                     // The claims an attacker asserts in the request. They are
                     // deliberately never passed to resolveWorkspaceContext —
                     // its inputs are the session userId and the lookup
                     // workspaceId only.
                     const injectedClaims = {
                        location,
                        role: fakeRole,
                        workspaceId: fakeWorkspaceId,
                     };
                     void injectedClaims;

                     // Resolve against the TRUE lookup workspaceId with a read
                     // permission (membership alone suffices). Everything in
                     // the returned context comes from the database.
                     const ctx = await resolveWorkspaceContext(
                        sql,
                        fixture.userId!,
                        fixture.workspaceId!,
                        'product.read'
                     );

                     // The role is the membership role, never the injected one.
                     assert.equal(
                        ctx.role,
                        TRUE_ROLE,
                        'ctx.role must equal the DB membership role, never the injected claim'
                     );
                     assert.notEqual(
                        ctx.role,
                        fakeRole,
                        'a request-asserted role claim must never become ctx.role'
                     );

                     // The scope is the confirmed workspace, never the claimed
                     // one.
                     assert.equal(
                        ctx.workspaceId,
                        fixture.workspaceId,
                        'ctx.workspaceId must equal the confirmed workspace'
                     );
                     assert.notEqual(
                        ctx.workspaceId,
                        fakeWorkspaceId,
                        'a request-asserted workspaceId claim must never become ctx.workspaceId'
                     );
                     assert.equal(ctx.userId, fixture.userId, 'ctx.userId is the session user');

                     // requireResource resolves the board by its STORED owning
                     // workspace. The board belongs to ctx.workspaceId, so it
                     // resolves — the claim played no part.
                     const db = scopedDb(sql, ctx);
                     await db.requireResource('boards', fixture.boardId!);

                     // A resource owned by the OTHER workspace is indistinguish-
                     // able from a non-existent id under this scope: NotFound.
                     // A claimed workspace cannot pull a foreign row into scope.
                     await assert.rejects(
                        db.requireResource('boards', fixture.otherBoardId!),
                        (error) => error instanceof NotFound,
                        'a resource stored in another workspace must be NotFound, not reachable via a claim'
                     );

                     // Resolving against a workspaceId the user is NOT a member
                     // of yields NotFound — a claim cannot grant membership.
                     await assert.rejects(
                        resolveWorkspaceContext(
                           sql,
                           fixture.userId!,
                           fakeWorkspaceId,
                           'product.read'
                        ),
                        (error) => error instanceof NotFound,
                        'a claimed foreign/non-existent workspace must never resolve to a context'
                     );
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
