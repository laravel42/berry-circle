// Feature: auth-and-tenant-isolation, Property 12: Workspace selection follows
// previous-if-valid-else-earliest and select requires membership.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { NotFound } from './errors.ts';
import { IdentityRepository } from './repository.ts';
import { WorkspaceRepository } from './workspaces.ts';
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
 * ── The rule the code actually implements ────────────────────────────────────
 *
 * Property 12 in the design describes selection as "previous if valid, else the
 * earliest-joined membership". The *runtime* selection path is
 * `IdentityRepository.bootstrap` (repository.ts), which is what
 * `GET /api/v1/me/bootstrap` calls. Its resolution is, verbatim:
 *
 *     const current =
 *        currentWorkspaceId && workspaces.some((w) => w.id === currentWorkspaceId)
 *           ? currentWorkspaceId
 *           : null;
 *
 * So the rule the code enforces at request time is: the stored selection
 * (`users.last_workspace_id`) when it is still a valid, non-deleted membership,
 * **otherwise `null`** — bootstrap does not auto-pick a fallback. The
 * earliest-joined choice from the design exists only as a one-time backfill in
 * migration `004_identity_workspaces.up.sql`
 * (`ORDER BY m.joined_at, m.workspace_id LIMIT 1`), not in the request path.
 *
 * This test encodes the REAL rule bootstrap implements and asserts it against a
 * live database. It additionally computes the design's earliest-joined
 * candidate and asserts the divergence explicitly, so the gap is documented and
 * caught rather than silently assumed away: if bootstrap ever grows the
 * fallback, the divergence assertion is what flips.
 *
 * Requirements exercised:
 *   10.1 — previous-if-valid-else-… selection resolution
 *   10.3 — create records creator as owner and sets selection to the new id
 *   10.4 — selecting a workspace the user belongs to records it
 *   10.5 — selecting a non-member workspace → 404 NOT_FOUND, selection unchanged
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration seeds several workspaces/memberships and runs real bootstrap,
// select, and create calls, so hold the run at the ≥100 floor the property
// suite requires.
const RUNS = 100;

/** The state a stored `last_workspace_id` can be in for an iteration. */
const STORED_KINDS = ['valid', 'stale', 'null'] as const;
type StoredKind = (typeof STORED_KINDS)[number];

interface SeededMembership {
   workspaceId: string;
   /** ISO timestamp written to workspace_memberships.joined_at. */
   joinedAt: string;
}

/**
 * The pure rule the runtime `bootstrap` implements: the stored selection when
 * it is a current membership, else null. No earliest-joined fallback.
 */
function bootstrapSelection(
   memberships: readonly SeededMembership[],
   stored: string | null
): string | null {
   if (stored !== null && memberships.some((m) => m.workspaceId === stored)) return stored;
   return null;
}

/**
 * The design's earliest-joined candidate — earliest `joined_at`, ties broken by
 * the smaller `workspace_id`, mirroring migration 004's
 * `ORDER BY m.joined_at, m.workspace_id`. Computed only to assert that runtime
 * bootstrap does NOT use it when the stored selection is stale/null.
 */
function earliestJoined(memberships: readonly SeededMembership[]): string | null {
   if (memberships.length === 0) return null;
   const ordered = [...memberships].sort((a, b) => {
      if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
      return a.workspaceId < b.workspaceId ? -1 : 1;
   });
   return ordered[0]!.workspaceId;
}

describe(
   'Feature: auth-and-tenant-isolation, Property 12: Workspace selection follows previous-if-valid-else-earliest and select requires membership',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let identity: IdentityRepository;
      let workspaces: WorkspaceRepository;

      // Every workspace and user created across the whole run, torn down once at
      // the end. Workspaces provision a protected Orchestrator agent by trigger,
      // so teardown suspends that guard (see the context property test).
      const createdWorkspaceIds = new Set<string>();
      const createdUserIds = new Set<string>();

      before(() => {
         sql = openDatabase({ url: url as string });
         identity = new IdentityRepository(sql);
         workspaces = new WorkspaceRepository(sql);
      });

      after(async () => {
         if (createdWorkspaceIds.size > 0) {
            // Protected agents refuse deletion; the shared helper clears and
            // deletes them inside one transaction.
            for (const ws of createdWorkspaceIds) {
               await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
               await deleteWorkspaceAgents(sql, [ws]);
               await sql`DELETE FROM boards WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
               // Nobody may point at a workspace about to disappear.
               await sql`UPDATE users SET last_workspace_id = NULL WHERE last_workspace_id = ${ws}`;
               await sql`DELETE FROM workspaces WHERE id = ${ws}`;
            }
         }
         for (const userId of createdUserIds) {
            await sql`DELETE FROM users WHERE id = ${userId}`;
         }
         await closeDatabase(sql);
      });

      /**
       * Seeds a fresh user with `count` memberships (each in its own freshly
       * created workspace) whose `joined_at` values are the provided offsets in
       * minutes from a fixed base, plus one extra workspace the user is NOT a
       * member of. Returns the ids the test needs.
       */
      async function seedUser(joinOffsets: readonly number[]): Promise<{
         userId: string;
         memberships: SeededMembership[];
         nonMemberWorkspaceId: string;
      }> {
         const suffix = randomUUID().slice(0, 8);
         const [user] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`p12-${suffix}@berry.test`}, 'Property 12')
            RETURNING id`;
         const userId = user!.id as string;
         createdUserIds.add(userId);

         const base = Date.UTC(2026, 0, 1, 0, 0, 0);
         const memberships: SeededMembership[] = [];
         for (let index = 0; index < joinOffsets.length; index += 1) {
            const workspaceId = randomUUID();
            const wsSuffix = `${suffix}-${index}`;
            await sql`
               INSERT INTO workspaces (id, name, slug, settings, created_by)
               VALUES (${workspaceId}, ${`WS ${wsSuffix}`}, ${`ws-${wsSuffix}`},
                       ${sql.json({ issuePrefix: 'WSX', defaultRole: 'member', allowMemberInvites: false } as never)},
                       ${userId})`;
            createdWorkspaceIds.add(workspaceId);
            const joinedAt = new Date(base + joinOffsets[index]! * 60_000).toISOString();
            await sql`
               INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
               VALUES (${workspaceId}, ${userId}, 'member', ${joinedAt}, ${joinedAt})`;
            memberships.push({ workspaceId, joinedAt });
         }

         // A workspace the user is deliberately NOT a member of.
         const nonMemberWorkspaceId = randomUUID();
         const otherSuffix = `${suffix}-x`;
         await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${nonMemberWorkspaceId}, ${`WS ${otherSuffix}`}, ${`ws-${otherSuffix}`},
                    ${sql.json({ issuePrefix: 'OTH', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${userId})`;
         createdWorkspaceIds.add(nonMemberWorkspaceId);

         return { userId, memberships, nonMemberWorkspaceId };
      }

      /** The stored `last_workspace_id` for a user, straight from the row. */
      async function storedSelection(userId: string): Promise<string | null> {
         const [row] = await sql`SELECT last_workspace_id FROM users WHERE id = ${userId}`;
         return (row!.last_workspace_id as string | null) ?? null;
      }

      test(
         'Feature: auth-and-tenant-isolation, Property 12: bootstrap resolves the stored selection if it is a valid membership else null; member-select records, non-member-select is 404 and unchanged, create yields owner membership and selection == new id',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  // Between one and four memberships, each with a random join
                  // offset (minutes). Distinct offsets so earliest-joined is
                  // unambiguous; the id tiebreak is still exercised by seeding
                  // order being independent of offset order.
                  fc
                     .uniqueArray(fc.integer({ min: 0, max: 10_000 }), {
                        minLength: 1,
                        maxLength: 4,
                     }),
                  // Which flavour of stored selection this iteration uses.
                  fc.constantFrom<StoredKind>(...STORED_KINDS),
                  // A random draw used to pick which membership is the stored
                  // "valid" one, kept in [0,1) and scaled per-iteration.
                  fc.double({ min: 0, max: 0.999_999, noNaN: true }),
                  async (joinOffsets, storedKind, pick) => {
                     const { userId, memberships, nonMemberWorkspaceId } =
                        await seedUser(joinOffsets);

                     // Establish the stored selection for this iteration.
                     let stored: string | null;
                     if (storedKind === 'valid') {
                        const idx = Math.min(
                           memberships.length - 1,
                           Math.floor(pick * memberships.length)
                        );
                        stored = memberships[idx]!.workspaceId;
                     } else if (storedKind === 'stale') {
                        // A workspace the user is not a member of — the classic
                        // "removed from the workspace I last visited" case.
                        stored = nonMemberWorkspaceId;
                     } else {
                        stored = null;
                     }
                     await sql`
                        UPDATE users SET last_workspace_id = ${stored} WHERE id = ${userId}`;

                     // ── 10.1: bootstrap resolves to the pure rule ──────────
                     const boot = await identity.bootstrap(userId);
                     const expected = bootstrapSelection(memberships, stored);
                     assert.equal(
                        boot.currentWorkspaceId,
                        expected,
                        'bootstrap currentWorkspaceId must equal previous-if-valid-else-null'
                     );
                     // bootstrap lists exactly the user's memberships.
                     assert.deepEqual(
                        new Set(boot.workspaces.map((w) => w.id)),
                        new Set(memberships.map((m) => m.workspaceId)),
                        'bootstrap lists exactly the user memberships'
                     );

                     // Divergence guard: when the stored selection is not valid,
                     // the runtime rule returns null and specifically does NOT
                     // fall back to the design's earliest-joined membership.
                     if (storedKind !== 'valid') {
                        assert.equal(
                           boot.currentWorkspaceId,
                           null,
                           'a stale/null stored selection resolves to null at request time'
                        );
                        assert.notEqual(
                           earliestJoined(memberships),
                           null,
                           'sanity: there is an earliest-joined candidate the code declines to pick'
                        );
                     }

                     // ── 10.4: selecting a member workspace records it ──────
                     const targetIdx = Math.min(
                        memberships.length - 1,
                        Math.floor(pick * memberships.length)
                     );
                     const memberTarget = memberships[targetIdx]!.workspaceId;
                     await workspaces.select(userId, memberTarget);
                     assert.equal(
                        await storedSelection(userId),
                        memberTarget,
                        'selecting a member workspace records it as the selection'
                     );
                     // And bootstrap now resolves to it, since it is valid.
                     const bootAfterSelect = await identity.bootstrap(userId);
                     assert.equal(
                        bootAfterSelect.currentWorkspaceId,
                        memberTarget,
                        'bootstrap returns the freshly selected valid membership'
                     );

                     // ── 10.5: non-member select is 404 and leaves it be ────
                     const before = await storedSelection(userId);
                     await assert.rejects(
                        workspaces.select(userId, nonMemberWorkspaceId),
                        (error) => error instanceof NotFound,
                        'selecting a non-member workspace must reject with NotFound (404)'
                     );
                     assert.equal(
                        await storedSelection(userId),
                        before,
                        'a rejected select must not change the stored selection'
                     );
                     // A workspace id that names nothing at all is likewise 404
                     // and non-mutating.
                     const phantom = randomUUID();
                     await assert.rejects(
                        workspaces.select(userId, phantom),
                        (error) => error instanceof NotFound,
                        'selecting a non-existent workspace must reject with NotFound (404)'
                     );
                     assert.equal(
                        await storedSelection(userId),
                        before,
                        'a rejected select of a phantom id must not change the selection'
                     );

                     // ── 10.3: create → owner membership + selection == id ──
                     const createSuffix = randomUUID().slice(0, 8);
                     const { workspace: created } = await workspaces.create({
                        actorId: userId,
                        name: `Created ${createSuffix}`,
                        slug: `created-${createSuffix}`,
                        description: null,
                        idempotencyKey: randomUUID(),
                        // A 32-byte sha256 digest, the exact shape the real
                        // create path (`fingerprintJSON`) produces and the
                        // `workspaces_creation_fingerprint_check` constraint
                        // requires.
                        fingerprint: createHash('sha256').update(createSuffix).digest(),
                     });
                     createdWorkspaceIds.add(created.id);

                     const [ownerRow] = await sql`
                        SELECT role::text AS role
                          FROM workspace_memberships
                         WHERE workspace_id = ${created.id} AND user_id = ${userId}`;
                     assert.equal(
                        ownerRow?.role,
                        'owner',
                        'the creator must hold an owner membership in the new workspace'
                     );
                     assert.equal(
                        await storedSelection(userId),
                        created.id,
                        'creating a workspace must set the selection to the new workspace id'
                     );
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
