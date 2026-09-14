// Feature: auth-and-tenant-isolation, Property 2: No cross-workspace read.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { BoardRepository } from '../core/boards.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
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
 * The property (design §Property 2, "No cross-workspace read"): for any world —
 * a set of workspaces, users, memberships with random roles, and workspace-
 * owned rows — and any caller, a workspace-scoped list returns only rows whose
 * owning workspace is one in which the caller holds a membership; a caller with
 * no membership in the requested workspace can never pull a foreign row into
 * view.
 *
 * The oracle, interpreted against the two endpoint shapes the read mounts
 * expose:
 *
 *   - `GET /api/v1/catalogs/{workspaceId}/issue-labels` gates on the path
 *     segment through `mountWorkspaceScope`: a member sees exactly that
 *     workspace's labels (every returned `workspaceId` equals the requested id,
 *     which is in the caller's membership set), and a non-member is 404 — the
 *     design's "empty collection for a no-membership caller" realised as an
 *     absence that is indistinguishable from a missing workspace, so no foreign
 *     row is ever returned.
 *   - `GET /api/v1/views?workspaceId=…` gates on the query parameter through
 *     `resolveScoped`: same guarantee, same 404 for a non-member.
 *
 * For every run this asserts the union guarantee directly: across every
 * membership a caller holds, each returned node's `workspaceId` is in that
 * caller's membership set; and for a workspace the caller is NOT a member of,
 * the read is 404 and yields no rows at all — including a caller who is a
 * member of nothing, who can read nowhere.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration drives real HTTP reads through the app against Postgres over a
// randomized world, so hold the run at the ≥100 floor the property suite
// requires.
const RUNS = 100;

/** The roles a membership can carry; every one may read (membership suffices). */
const ROLE_POOL = ['owner', 'admin', 'member', 'viewer'] as const;

interface World {
   /** Workspace ids, in creation order. */
   workspaces: string[];
   /** User ids, in creation order. */
   users: string[];
   /** For each user id, the set of workspace ids the user is a member of. */
   membershipsByUser: Map<string, Set<string>>;
   /** For each workspace id, the set of label ids owned by that workspace. */
   labelsByWorkspace: Map<string, Set<string>>;
}

/**
 * A single generated world: N workspaces, M users, random memberships (some
 * users may end up in none), and K labels per workspace. Built inside the
 * property so every run exercises a fresh, differently-shaped world; torn down
 * by {@link dropWorld} once the run's assertions have all passed.
 */
async function buildWorld(
   sql: Sql,
   shape: {
      workspaceCount: number;
      userCount: number;
      membershipChoices: number[];
      labelCounts: number[];
   }
): Promise<World> {
   const suffix = randomUUID().slice(0, 8);

   const users: string[] = [];
   for (let u = 0; u < shape.userCount; u += 1) {
      const [row] = await sql`
         INSERT INTO users (id, email, name)
         VALUES (${randomUUID()}, ${`p2-${suffix}-u${u}@berry.test`}, ${`P2 User ${u}`})
         RETURNING id`;
      users.push(row!.id as string);
   }

   const workspaces: string[] = [];
   const labelsByWorkspace = new Map<string, Set<string>>();
   for (let w = 0; w < shape.workspaceCount; w += 1) {
      // Every workspace needs a creator; use the first user as a stable author.
      const creator = users[0]!;
      const [row] = await sql`
         INSERT INTO workspaces (id, name, slug, settings, created_by)
         VALUES (${randomUUID()}, ${`P2 WS ${suffix}-${w}`}, ${`p2-${suffix}-${w}`},
                 ${sql.json({ issuePrefix: 'P2W', defaultRole: 'member', allowMemberInvites: false } as never)},
                 ${creator})
         RETURNING id`;
      const workspaceId = row!.id as string;
      workspaces.push(workspaceId);

      const labels = new Set<string>();
      const labelCount = shape.labelCounts[w] ?? 0;
      for (let k = 0; k < labelCount; k += 1) {
         const [label] = await sql`
            INSERT INTO issue_labels (id, workspace_id, name, color, created_by)
            VALUES (${randomUUID()}, ${workspaceId}, ${`label-${w}-${k}`}, '#6366f1', ${creator})
            RETURNING id`;
         labels.add(label!.id as string);
      }
      labelsByWorkspace.set(workspaceId, labels);
   }

   // Random memberships. `membershipChoices` is a flat bitmask stream: for each
   // (user, workspace) pair a 0/1 decides membership, so some users land in
   // several workspaces and some in none at all.
   const membershipsByUser = new Map<string, Set<string>>();
   let choice = 0;
   for (const userId of users) {
      const owned = new Set<string>();
      for (const workspaceId of workspaces) {
         const decide = shape.membershipChoices[choice % shape.membershipChoices.length] ?? 0;
         choice += 1;
         if (decide === 1) {
            const role = ROLE_POOL[choice % ROLE_POOL.length]!;
            await sql`
               INSERT INTO workspace_memberships (workspace_id, user_id, role)
               VALUES (${workspaceId}, ${userId}, ${role})
               ON CONFLICT (workspace_id, user_id) DO NOTHING`;
            owned.add(workspaceId);
         }
      }
      membershipsByUser.set(userId, owned);
   }

   return { workspaces, users, membershipsByUser, labelsByWorkspace };
}

/**
 * Removes a world's rows. A workspace provisions a protected Orchestrator agent
 * by trigger, and protected agents refuse deletion, so the shared helper clears
 * and deletes it inside one transaction.
 */
async function dropWorld(sql: Sql, world: World): Promise<void> {
   for (const workspaceId of world.workspaces) {
      await sql`DELETE FROM outbox_events WHERE workspace_id = ${workspaceId}`;
      await deleteWorkspaceAgents(sql, [workspaceId]);
      await deleteWorkspaceBoards(sql, [workspaceId]);
      await sql`DELETE FROM issue_labels WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`;
      await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
   }
   for (const userId of world.users) {
      await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
      await sql`DELETE FROM users WHERE id = ${userId}`;
   }
}

describe(
   'Feature: auth-and-tenant-isolation, Property 2: No cross-workspace read',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let sessions: SessionService;
      let app: ReturnType<typeof createApp>;

      before(() => {
         sql = openDatabase({ url: url as string });
         sessions = new SessionService({ sql, auth: null, bearer: [personalTokenResolver(sql)] });
         const registry = new Registry();
         registry.registerAll(
            workspaceReadMounts({ sessions, sql, boards: new BoardRepository(sql) })
         );
         app = createApp(registry);
      });

      after(async () => {
         await closeDatabase(sql);
      });

      /** Issue a personal access token for a seeded user and read a workspace's labels. */
      async function listLabels(userId: string, workspaceId: string): Promise<Response> {
         const token = await issueTestToken(sql, userId);
         return app.request(`/api/v1/catalogs/${workspaceId}/issue-labels`, {
            headers: { authorization: `Bearer ${token}` },
         });
      }

      /** Issue a personal access token for a seeded user and read views by query param. */
      async function listViews(userId: string, workspaceId: string): Promise<Response> {
         const token = await issueTestToken(sql, userId);
         return app.request(`/api/v1/views?workspaceId=${workspaceId}`, {
            headers: { authorization: `Bearer ${token}` },
         });
      }

      test(
         'Feature: auth-and-tenant-isolation, Property 2: every returned node belongs to a workspace in the caller\'s membership set, and a caller with no membership in the requested workspace receives no foreign rows',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  // N workspaces (>=1 so there is something to own), M users
                  // (>=2 so a non-member caller is always available), a bitmask
                  // stream for memberships, and a per-workspace label count.
                  fc.integer({ min: 1, max: 4 }),
                  fc.integer({ min: 2, max: 4 }),
                  fc.array(fc.integer({ min: 0, max: 1 }), { minLength: 4, maxLength: 24 }),
                  fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 4, maxLength: 4 }),
                  async (workspaceCount, userCount, membershipChoices, labelCounts) => {
                     const world = await buildWorld(sql, {
                        workspaceCount,
                        userCount,
                        membershipChoices,
                        labelCounts,
                     });

                     try {
                        for (const userId of world.users) {
                           const memberOf = world.membershipsByUser.get(userId)!;

                           for (const workspaceId of world.workspaces) {
                              const isMember = memberOf.has(workspaceId);

                              // The catalogs endpoint gates on the path segment.
                              const labelResponse = await listLabels(userId, workspaceId);

                              if (isMember) {
                                 // A member reads exactly this workspace's rows:
                                 // every node's workspaceId is the requested id,
                                 // which is in the caller's membership set, and
                                 // the id set matches what the workspace owns —
                                 // never a foreign workspace's label.
                                 assert.equal(
                                    labelResponse.status,
                                    200,
                                    'a member must be able to read the workspace catalog'
                                 );
                                 const body = (await labelResponse.json()) as {
                                    nodes: Array<{ id: string; workspaceId: string }>;
                                 };
                                 for (const node of body.nodes) {
                                    assert.equal(
                                       node.workspaceId,
                                       workspaceId,
                                       'a returned node must belong to the requested workspace'
                                    );
                                    assert.ok(
                                       memberOf.has(node.workspaceId),
                                       'a returned node\'s workspaceId must be in the caller\'s membership set'
                                    );
                                    assert.ok(
                                       world.labelsByWorkspace.get(workspaceId)!.has(node.id),
                                       'a returned node must be a label this workspace actually owns'
                                    );
                                 }
                                 const returned = new Set(body.nodes.map((node) => node.id));
                                 for (const ownedId of world.labelsByWorkspace.get(workspaceId)!) {
                                    assert.ok(
                                       returned.has(ownedId),
                                       'a member must see every non-archived label the workspace owns'
                                    );
                                 }
                              } else {
                                 // A non-member cannot pull any foreign row into
                                 // view: the read is 404 (indistinguishable from
                                 // a missing workspace), never a leak of the
                                 // workspace's labels.
                                 assert.equal(
                                    labelResponse.status,
                                    404,
                                    'a non-member must not be able to read the workspace catalog'
                                 );
                              }

                              // The views endpoint gates on the query param: same
                              // guarantee. A member gets 200 and only rows for a
                              // workspace it belongs to; a non-member gets 404.
                              const viewResponse = await listViews(userId, workspaceId);
                              if (isMember) {
                                 assert.equal(
                                    viewResponse.status,
                                    200,
                                    'a member must be able to list views for the workspace'
                                 );
                                 const body = (await viewResponse.json()) as {
                                    nodes: Array<{ workspaceId: string }>;
                                 };
                                 for (const node of body.nodes) {
                                    assert.ok(
                                       memberOf.has(node.workspaceId),
                                       'a returned view must belong to a workspace in the caller\'s membership set'
                                    );
                                 }
                              } else {
                                 assert.equal(
                                    viewResponse.status,
                                    404,
                                    'a non-member must not be able to list views for the workspace'
                                 );
                              }
                           }
                        }
                     } finally {
                        await dropWorld(sql, world);
                     }
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
