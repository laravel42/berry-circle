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
import { runtimeMounts } from './runtimes.ts';
import { workspaceReadMounts } from './workspace-reads.ts';
import { issueMounts } from './issues.ts';
import { issueTrackingRoutes } from './issue-tracking.ts';
import { agentMounts } from './agents.ts';
import { AgentRepository } from '../agents/repository.ts';
import { AgentProfileRepository } from '../agents/profile.ts';
import { IdempotencyStore } from '../http/idempotency.ts';
import { IssueRepository } from '../core/issues.ts';
import { GitHubSettingsRepository } from '../scm/github-settings.ts';
import { PullRequestStore } from '../scm/pull-requests.ts';
import { githubMounts } from './github.ts';
import { usageMounts } from './usage.ts';
import { workCatalogRoutes } from './work-catalogs.ts';
import { savedViewRoutes } from './view-routes.ts';
import { CommentRepository } from '../core/comments.ts';
import { sealerFromKey } from '../integrations/sealing.ts';
import { parsePackage } from '../plugins/manifest.ts';
import { PluginRepository } from '../plugins/repository.ts';
import { PluginRuntimeStore } from '../plugins/runtime-store.ts';
import { pluginMounts } from './plugins.ts';
import { publicApiMounts } from './public-api.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { secretsMounts } from './secrets.ts';
import { WorkspaceRepository } from '../identity/workspaces.ts';
import { workspaceMounts } from './workspaces.ts';

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
   w2RuntimeId: string;
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
   w1RepoUrl: string;
   w2RepoUrl: string;
   w2RepoId: string;
   /** W2's GitHub App installation — one workspace's, and only one's. */
   w2InstallationId: number;
   /** An open invitation into W2, addressed to nobody in this test. */
   w2InvitationId: string;
   w1IssueId: string;
   w2IssueId: string;
}

describe(
   'Feature: auth-and-tenant-isolation, cross-tenant leakage (explicit two-workspace guarantees)',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;
      const world = {} as World;
      /** W2's installed plugin and a token minted for it (workstream G). */
      const plugin = { w2InstallationId: '', w2Token: '' };

      before(async () => {
         sql = openDatabase({ url: url as string });

         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         const boards = new BoardRepository(sql);
         const registry = new Registry();
         // With the work-tracking extensions mounted, so their routes sit
         // behind the same guard these guarantees exercise.
         registry.registerAll(
            workspaceReadMounts({
               sessions,
               sql,
               boards,
               catalogExtensions: workCatalogRoutes(),
               viewExtensions: savedViewRoutes({ sql }),
            })
         );
         // The issues mount, carrying its work-tracking routes — which is
         // where an issue's labels are read and written (workstream F2).
         const leakIssues = new IssueRepository(sql);
         registry.registerAll(
            issueMounts({
               sessions,
               issues: leakIssues,
               boards,
               idempotency: new IdempotencyStore(sql),
               tracking: issueTrackingRoutes({
                  sql,
                  issues: leakIssues,
                  boards,
                  comments: new CommentRepository(sql),
               }),
            })
         );
         registry.registerAll(runtimeMounts({ sessions, sql, sealer: null, health: async () => {} }));
         registry.registerAll(usageMounts({ sessions, sql }));
         // The personal invitation routes: not workspace-scoped, scoped to the
         // caller's own address, which is the guarantee tested below.
         registry.registerAll(secretsMounts({ sessions, secrets: new SecretsRepository(sql) }));
         // The agents mount, so its roster and its environment routes sit
         // behind the same guard these guarantees exercise.
         registry.registerAll(
            agentMounts({
               sessions,
               agents: new AgentRepository(sql),
               idempotency: new IdempotencyStore(sql),
               catalog: null,
               profile: new AgentProfileRepository({
                  sql,
                  sealer: sealerFromKey(Buffer.alloc(32, 9).toString('base64')),
               }),
            })
         );
         // Workstream F5: workspace administration, so its reads, its writes
         // and "leave" are held to the same guarantees as everything else.
         registry.registerAll(
            workspaceMounts({
               sessions,
               workspaces: new WorkspaceRepository(sql),
               secrets: new SecretsRepository(sql),
            })
         );
         registry.registerAll(
            githubMounts({
               sessions,
               sql,
               settings: new GitHubSettingsRepository(sql),
               pullRequests: new PullRequestStore({ sql, issues: new IssueRepository(sql) }),
               githubApp: null,
               connections: null,
            })
         );
         // Workstream G: the plugin admin mount and the public API.
         const pluginRepo = new PluginRepository({
            sql,
            sealer: sealerFromKey(Buffer.alloc(32, 7).toString('base64')),
         });
         const pluginRuntime = new PluginRuntimeStore({ sql });
         registry.registerAll(
            pluginMounts({
               sessions,
               sql,
               plugins: pluginRepo,
               runtime: pluginRuntime,
               network: { request: async () => ({ status: 500, body: '' }) },
               publicUrl: null,
            })
         );
         registry.registerAll(
            publicApiMounts({
               personalTokens: personalTokenResolver(sql),
               sql,
               issues: new IssueRepository(sql),
               comments: new CommentRepository(sql),
               plugins: pluginRuntime,
            })
         );
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

         // An open invitation into W2, addressed to a third party. U1 is not
         // that party, so it is none of U1's business — in the list or out of it.
         const [w2Invitation] = await sql`
            INSERT INTO workspace_invitations
               (id, workspace_id, email, role, invited_by, token_hash,
                idempotency_key_hash, request_fingerprint, expires_at)
            VALUES (${randomUUID()}, ${world.w2Id}, ${`leak-invitee-${suffix}@berry.test`},
                    'member', ${u2Id}, ${Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 2)},
                    ${Buffer.alloc(32, 3)},
                    ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()})
            RETURNING id`;
         world.w2InvitationId = w2Invitation!.id as string;

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

         // GitHub rows in each workspace: W2 has switched GitHub off, so a
         // write that reached it would be visible as the flag flipping back.
         world.w1RepoUrl = `https://github.com/w1-${suffix}/api`;
         world.w2RepoUrl = `https://github.com/w2-${suffix}/secret`;
         await sql`
            INSERT INTO workspace_repositories (workspace_id, url, created_by)
            VALUES (${world.w1Id}, ${world.w1RepoUrl}, ${u1Id})`;
         const [w2Repo] = await sql`
            INSERT INTO workspace_repositories (workspace_id, url, created_by)
            VALUES (${world.w2Id}, ${world.w2RepoUrl}, ${u2Id})
            RETURNING id`;
         world.w2RepoId = w2Repo!.id as string;

         // W2's GitHub account, which is the row a workspace reaching several
         // accounts makes newly interesting: an installation belongs to exactly
         // one workspace, so W1 must be unable to list it or disconnect it.
         world.w2InstallationId = 6_180_000 + Math.floor(Math.random() * 100_000);
         await sql`
            INSERT INTO github_installations (workspace_id, installation_id, account_login,
                   account_type, installed_by)
            VALUES (${world.w2Id}, ${world.w2InstallationId}, ${`w2-org-${suffix}`},
                    'Organization', ${u2Id})`;

         // One task on each board, so an issue-scoped route has a real target
         // in both tenants. W2's carries a label, which is exactly the row a
         // leak would expose.
         const seedIssue = async (boardId: string, creatorId: string, title: string): Promise<string> => {
            const id = randomUUID();
            const [counter] = await sql`
               UPDATE boards SET issue_counter = issue_counter + 1 WHERE id = ${boardId}
               RETURNING issue_counter`;
            await sql`
               INSERT INTO issues (id, board_id, number, title, status, created_by)
               VALUES (${id}, ${boardId}, ${Number(counter!.issue_counter)}, ${title},
                       'backlog'::issue_status, ${creatorId})`;
            return id;
         };
         world.w1IssueId = await seedIssue(world.w1BoardId, u1Id, `w1-task-${suffix}`);
         world.w2IssueId = await seedIssue(world.w2BoardId, u2Id, `w2-task-${suffix}`);
         await sql`
            INSERT INTO issue_label_memberships (workspace_id, issue_id, label_id, assigned_by)
            VALUES (${world.w2Id}, ${world.w2IssueId}, ${world.w2LabelId}, ${u2Id})`;
         await sql`
            INSERT INTO github_workspace_settings (workspace_id, enabled, updated_by)
            VALUES (${world.w2Id}, false, ${u2Id})`;

         // W2's runtime. Rows cascade with the workspace, so the teardown
         // needs nothing new.
         const [w2Runtime] = await sql`
            INSERT INTO agent_runtimes (workspace_id, name, kind, driver, endpoint_url)
            VALUES (${world.w2Id}, 'W2 runtime', 'custom', 'http', 'http://w2-runtime:8080')
            RETURNING id`;
         world.w2RuntimeId = w2Runtime!.id as string;

         // W2's plugin (workstream G), with a sealed secret and a token of its own.
         const [w2Plugin] = await sql.begin((tx) =>
            pluginRepo.install(tx, {
               workspaceId: world.w2Id,
               installedBy: u2Id,
               pkg: parsePackage({
                  manifest: {
                     schemaVersion: 1,
                     key: 'leak-probe',
                     name: 'Leak probe',
                     version: '1.0.0',
                     baseUrl: 'https://leak-probe.example.com',
                     scopes: ['issues:read'],
                     secrets: [{ name: 'API_KEY' }],
                     surfaces: [{ key: 'panel', title: 'Panel', path: '/ui' }],
                  },
                  files: [],
               }),
               source: 'upload',
               sourceUrl: null,
               config: {},
            }).then((installed) => [installed.installation])
         );
         plugin.w2InstallationId = w2Plugin!.id;
         await sql.begin((tx) => pluginRepo.setSecret(tx, world.w2Id, plugin.w2InstallationId, 'API_KEY', 'w2-only'));
         plugin.w2Token = (
            await pluginRuntime.mintToken({
               workspaceId: world.w2Id,
               installationId: plugin.w2InstallationId,
               scopes: ['issues:read'],
               ttlMs: 60_000,
            })
         ).token;

         // U1's current workspace is W1, which is what a mount that scopes
         // to the session's workspace (/api/v1/runtimes) reads.
         await sql`UPDATE users SET last_workspace_id = ${world.w1Id} WHERE id = ${u1Id}`;
         // A real personal access token for U1 (the same bearer path an API
         // client uses); every authenticated request below carries it.
         world.u1Token = await issueTestToken(sql, u1Id);
      });

      after(async () => {
         if (!sql) return;
         if (world.workspaceIds?.length) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. The shared helper clears and
            // deletes it inside one transaction.
            for (const ws of world.workspaceIds) {
               await sql`DELETE FROM outbox_events WHERE workspace_id = ${ws}`;
               await deleteWorkspaceAgents(sql, [ws]);
               await sql`DELETE FROM workspace_invitations WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM saved_issue_views WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM issue_labels WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM issue_status_definitions WHERE workspace_id = ${ws}`;
               // Before the boards they hang off; memberships cascade with them.
               await sql`
                  DELETE FROM issues
                   WHERE board_id IN (SELECT id FROM boards WHERE workspace_id = ${ws})`;
               await sql`DELETE FROM boards WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${ws}`;
               await sql`DELETE FROM workspaces WHERE id = ${ws}`;
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

      /**
       * Workstream F2: the labels on a task.
       *
       * Both routes hang under `/api/v1/issues/:issueRef`, so they inherit the
       * find-before-permission order — and this asserts it end to end: W2's
       * task reads as a plain 404, identical to a uuid that names nothing, and
       * a write aimed at it changes no row in W2. The last case is the one a
       * label brings with it: W1's own task must not be able to borrow a label
       * belonging to another tenant, which would put a W2 row on a W1 task
       * without ever touching a W2 issue.
       */
      test('(b)+(c) an issue\'s labels do not cross a workspace boundary', async () => {
         const putAsU1 = (path: string, body: unknown): Promise<Response> =>
            Promise.resolve(
               app.request(path, {
                  method: 'PUT',
                  headers: {
                     'authorization': `Bearer ${world.u1Token}`,
                     'content-type': 'application/json',
                     'x-request-id': REQUEST_ID,
                  },
                  body: JSON.stringify(body),
               })
            );

         const own = await getAsU1(`/api/v1/issues/${world.w1IssueId}/labels`);
         assert.equal(own.status, 200);
         assert.deepEqual(((await own.json()) as { nodes: unknown[] }).nodes, []);

         const foreign = await getAsU1(`/api/v1/issues/${world.w2IssueId}/labels`);
         const absent = await getAsU1(`/api/v1/issues/${randomUUID()}/labels`);
         assert.equal(foreign.status, 404);
         assert.equal(absent.status, 404);
         assert.deepEqual(await foreign.json(), await absent.json());

         const clearForeign = await putAsU1(`/api/v1/issues/${world.w2IssueId}/labels`, {
            labelIds: [],
         });
         assert.equal(clearForeign.status, 404);
         const [kept] = await sql`
            SELECT count(*)::int AS n FROM issue_label_memberships
             WHERE issue_id = ${world.w2IssueId}`;
         assert.equal(Number(kept!.n), 1, "W2's label is still on W2's task");

         const borrow = await putAsU1(`/api/v1/issues/${world.w1IssueId}/labels`, {
            labelIds: [world.w2LabelId],
         });
         assert.equal(borrow.status, 404);
         const [borrowed] = await sql`
            SELECT count(*)::int AS n FROM issue_label_memberships
             WHERE issue_id = ${world.w1IssueId}`;
         assert.equal(Number(borrowed!.n), 0);
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

      /** Authenticated DELETE as U1, with the fixed request id. */
      function deleteAsU1(path: string): Promise<Response> {
         return Promise.resolve(
            app.request(path, {
               method: 'DELETE',
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

      /** Authenticated POST as U1, with an idempotency key and the fixed id. */
      function postAsU1(path: string): Promise<Response> {
         return Promise.resolve(
            app.request(path, {
               method: 'POST',
               headers: {
                  authorization: `Bearer ${world.u1Token}`,
                  'content-type': 'application/json',
                  'Idempotency-Key': randomUUID(),
                  'x-request-id': REQUEST_ID,
               },
               body: JSON.stringify({}),
            })
         );
      }

      test('invitations: a W2 invitation is invisible to U1 and cannot be joined or declined', async () => {
         // (a) U1's own pending list never carries it.
         const pending = await getAsU1('/api/v1/invitations/pending');
         assert.equal(pending.status, 200);
         assert.equal((await pending.text()).includes(world.w2InvitationId), false);

         // (b) Acting on it is the same 404 as acting on one that never existed.
         const join = await postAsU1(`/api/v1/invitations/${world.w2InvitationId}/join`);
         const absentJoin = await postAsU1(`/api/v1/invitations/${randomUUID()}/join`);
         assert.equal(join.status, 404);
         assert.equal(await join.text(), await absentJoin.text());

         const decline = await postAsU1(`/api/v1/invitations/${world.w2InvitationId}/decline`);
         assert.equal(decline.status, 404);

         // (c) W2 is unchanged: the invitation still stands and U1 is still out.
         const [row] = await sql`
            SELECT accepted_at, revoked_at FROM workspace_invitations
             WHERE id = ${world.w2InvitationId}`;
         assert.equal(row!.accepted_at, null, 'the W2 invitation was not accepted');
         assert.equal(row!.revoked_at, null, 'the W2 invitation was not revoked');
         const u1Id = world.userIds[0] ?? '';
         const [membership] = await sql`
            SELECT 1 FROM workspace_memberships
             WHERE workspace_id = ${world.w2Id} AND user_id = ${u1Id}`;
         assert.equal(membership, undefined, 'U1 did not become a member of W2');
      });
      // ------------------------------------------------- agents (workstream F4)

      test(
         'agents: the roster carries none of W2’s agents, and W2’s environment cannot be revealed or audited',
         async () => {
            // Every workspace is provisioned with a protected Orchestrator, so
            // W2 has a real agent without this test seeding one.
            const [w2Agent] = await sql`
               SELECT id FROM agents WHERE workspace_id = ${world.w2Id} LIMIT 1`;
            const w2AgentId = w2Agent!.id as string;

            // (a) The roster is the caller's own workspace, whatever else exists.
            const roster = await getAsU1('/api/v1/agents/roster');
            assert.equal(roster.status, 200);
            assert.equal((await roster.text()).includes(w2AgentId), false);

            // (b) Reading W2's environment record is the byte-identical 404 of
            // an agent that does not exist at all.
            const foreignAudit = await getAsU1(`/api/v1/agents/${w2AgentId}/env/audit`);
            const absentAudit = await getAsU1(`/api/v1/agents/${randomUUID()}/env/audit`);
            assert.equal(foreignAudit.status, 404);
            assert.equal(await foreignAudit.text(), await absentAudit.text());

            // (c) Revealing it is refused, and the attempt leaves nothing —
            // neither values returned nor a record implying it was opened.
            const reveal = await postAsU1(`/api/v1/agents/${w2AgentId}/env/reveal`);
            assert.equal(reveal.status, 404);
            assert.equal((await reveal.text()).includes('env'), false);
            const [recorded] = await sql`
               SELECT count(*)::int AS n FROM agent_env_audit WHERE agent_id = ${w2AgentId}`;
            assert.equal(Number(recorded!.n), 0, 'no audit row was written against W2’s agent');
         }
      );

      test('runtimes: W1 lists none of W2 and cannot open or change W2 runtime', async () => {
         const list = await getAsU1('/api/v1/runtimes');
         assert.equal(list.status, 200);
         assert.equal((await list.text()).includes(world.w2RuntimeId), false);
         assert.equal((await getAsU1(`/api/v1/runtimes/${world.w2RuntimeId}`)).status, 404);
         assert.equal((await patchAsU1(`/api/v1/runtimes/${world.w2RuntimeId}`, { name: 'mine' })).status, 404);
         const [row] = await sql`SELECT name FROM agent_runtimes WHERE id = ${world.w2RuntimeId}`;
         assert.equal(row!.name, 'W2 runtime');
      });

      test('runtimes: agent coverage never names an agent of W2', async () => {
         const coverage = await getAsU1('/api/v1/runtimes/agent-coverage');
         assert.equal(coverage.status, 200);
         const body = await coverage.text();
         const [w2Agent] = await sql`SELECT id FROM agents WHERE workspace_id = ${world.w2Id} LIMIT 1`;
         assert.ok(w2Agent, 'W2 has at least its provisioned agent');
         assert.equal(body.includes(w2Agent!.id as string), false);
      });

      test('usage and dashboard reads under a foreign workspace are the same 404 as an absent one', async () => {
         const tails = [
            '/summary',
            '/errors',
            '/runtimes/default',
            `/agents/${randomUUID()}`,
            `/issues/${randomUUID()}`,
         ];
         for (const tail of tails) {
            const foreign = await getAsU1(`/api/v1/usage/${world.w2Id}${tail}`);
            const absent = await getAsU1(`/api/v1/usage/${RANDOM_WORKSPACE}${tail}`);
            assert.equal(foreign.status, 404, tail);
            assert.equal(await foreign.text(), await absent.text(), tail);
         }
         const foreign = await getAsU1(`/api/v1/dashboard/${world.w2Id}/overview`);
         const absent = await getAsU1(`/api/v1/dashboard/${RANDOM_WORKSPACE}/overview`);
         assert.equal(foreign.status, 404);
         assert.equal(await foreign.text(), await absent.text());
      });

      // ------------------------------------ workspace administration (F5)

      test('workspaces: W2 is invisible to U1, and cannot be renamed, re-contexted, or left', async () => {
         // (a) The list U1 is entitled to never carries W2.
         const listed = await getAsU1('/api/v1/workspaces');
         assert.equal(listed.status, 200);
         assert.equal((await listed.text()).includes(world.w2Id), false);

         // (b) Reading W2 is the byte-identical 404 of a workspace that does
         // not exist, so the refusal never confirms W2 is real.
         const foreign = await getAsU1(`/api/v1/workspaces/${world.w2Id}`);
         const absent = await getAsU1(`/api/v1/workspaces/${RANDOM_WORKSPACE}`);
         assert.equal(foreign.status, 404);
         assert.equal(await foreign.text(), await absent.text());

         const snapshot = async () => {
            const [row] = await sql`
               SELECT name, description, agent_context, logo_url
                 FROM workspaces WHERE id = ${world.w2Id}`;
            const [members] = await sql`
               SELECT count(*)::int AS count
                 FROM workspace_memberships WHERE workspace_id = ${world.w2Id}`;
            return { row: { ...row }, members: (members as { count: number }).count };
         };
         const before = await snapshot();

         // (c) Every write is 404, including the fields the General page added
         // in migration 174.
         for (const body of [
            { name: 'mine now' },
            { description: 'mine now' },
            { agentContext: 'Do as I say.' },
            { logoUrl: 'https://example.test/mine.png' },
         ]) {
            const refused = await patchAsU1(`/api/v1/workspaces/${world.w2Id}`, body);
            assert.equal(refused.status, 404, JSON.stringify(body));
         }

         // (d) Leaving a workspace you were never in is the same 404, and does
         // not touch its roster — a membership U1 never had cannot be deleted.
         const left = await app.request(`/api/v1/workspaces/${world.w2Id}/leave`, {
            method: 'POST',
            headers: { authorization: `Bearer ${world.u1Token}`, 'x-request-id': REQUEST_ID },
         });
         assert.equal(left.status, 404);

         assert.deepEqual(await snapshot(), before, 'W2 is untouched');
      });

      test('catalogues: the archived reads and the member hover card do not cross a workspace', async () => {
         // Asking for archived rows is still a scoped read: `includeArchived`
         // widens what a member of W1 sees inside W1, never who may look.
         for (const path of [
            `/api/v1/catalogs/${world.w2Id}/issue-statuses?includeArchived=true`,
            `/api/v1/catalogs/${world.w2Id}/quick-actions?includeArchived=true`,
            `/api/v1/catalogs/${world.w2Id}/issue-properties?includeArchived=true`,
         ]) {
            const foreign = await getAsU1(path);
            assert.equal(foreign.status, 404, path);
         }

         // The label usage count is a count of W1's own memberships. A W2
         // label is not listed at all, so no count for one can leak.
         const labels = (await (await getAsU1(
            `/api/v1/catalogs/${world.w1Id}/issue-labels`
         )).json()) as { nodes: Array<{ id: string; usageCount: number }> };
         assert.ok(
            labels.nodes.every((node) => node.id !== world.w2LabelId),
            'a W2 label must not be counted under W1'
         );
         assert.ok(
            labels.nodes.every((node) => Number.isInteger(node.usageCount)),
            'every listed label carries a count'
         );

         // And the hover card: U1 may not ask what agents run on the work of
         // somebody they cannot see, and the refusal is the 404 of an absent
         // workspace rather than one that names W2 as real.
         const foreignMember = await getAsU1(
            `/api/v1/workspaces/${world.w2Id}/members/${world.userIds[1] as string}/top-agents`
         );
         const absentMember = await getAsU1(
            `/api/v1/workspaces/${RANDOM_WORKSPACE}/members/${world.userIds[1] as string}/top-agents`
         );
         assert.equal(foreignMember.status, 404);
         assert.equal(await foreignMember.text(), await absentMember.text());

         // Even inside their own workspace, asking about somebody who is not
         // in it is the same 404: a membership elsewhere is not U1's to learn.
         const outsiderHere = await getAsU1(
            `/api/v1/workspaces/${world.w1Id}/members/${world.userIds[1] as string}/top-agents`
         );
         assert.equal(outsiderHere.status, 404);
      });

      test("usage: W2's project cannot be used as W1's filter", async () => {
         for (const tail of ['/summary', '/errors']) {
            const foreign = await getAsU1(
               `/api/v1/usage/${world.w1Id}${tail}?boardId=${world.w2BoardId}`
            );
            const absent = await getAsU1(
               `/api/v1/usage/${world.w1Id}${tail}?boardId=${RANDOM_WORKSPACE}`
            );
            assert.equal(foreign.status, 404, tail);
            assert.equal(await foreign.text(), await absent.text(), tail);
         }
         // W1's own project is readable, so the 404 above is about the tenant
         // boundary and not about the parameter being refused outright.
         const own = await getAsU1(`/api/v1/usage/${world.w1Id}/summary?boardId=${world.w1BoardId}`);
         assert.equal(own.status, 200);
      });

      // ------------------------------------------- plugins and /v1 (workstream G)

      test(
         'plugins and /v1: a W1 member never sees, reads or changes W2’s plugin, and a W2 plugin token stays in W2',
         async () => {
            // (a) W1's installation list never carries W2's plugin.
            const listed = await getAsU1(`/api/v1/plugins/${world.w1Id}/installations`);
            assert.equal(listed.status, 200);
            assert.equal((await listed.text()).includes(plugin.w2InstallationId), false);

            // (b) Every plugin read under W2 is the byte-identical 404 of a
            // workspace that does not exist; a W2 id under W1 is a missing plugin.
            for (const tail of ['installations', `installations/${plugin.w2InstallationId}`]) {
               const foreign = await getAsU1(`/api/v1/plugins/${world.w2Id}/${tail}`);
               const missing = await getAsU1(`/api/v1/plugins/${RANDOM_WORKSPACE}/${tail}`);
               assert.equal(foreign.status, 404, tail);
               assert.equal(await foreign.text(), await missing.text(), tail);
            }
            const crossed = await getAsU1(`/api/v1/plugins/${world.w1Id}/installations/${plugin.w2InstallationId}`);
            const random = await getAsU1(`/api/v1/plugins/${world.w1Id}/installations/${randomUUID()}`);
            assert.equal(crossed.status, 404);
            assert.equal(await crossed.text(), await random.text());

            // (c) Disabling W2's plugin from either scope is 404, and W2 is unchanged.
            assert.equal(
               (await patchAsU1(`/api/v1/plugins/${world.w1Id}/installations/${plugin.w2InstallationId}`, { enabled: false })).status,
               404
            );
            assert.equal(
               (await patchAsU1(`/api/v1/plugins/${world.w2Id}/installations/${plugin.w2InstallationId}`, { enabled: false })).status,
               404
            );
            const [row] = await sql`SELECT enabled FROM plugin_installations WHERE id = ${plugin.w2InstallationId}`;
            assert.equal(row?.enabled, true, 'W2 plugin is still enabled');

            // /v1: U1's key sees only W1; W2's plugin token sees only W2 and no W1 issue.
            const u1Context = (await (await getAsU1('/v1/context')).json()) as { workspaces: { id: string }[] };
            assert.deepEqual(u1Context.workspaces.map((w) => w.id), [world.w1Id]);
            const pluginContext = (await (
               await app.request('/v1/context', {
                  headers: { authorization: `Bearer ${plugin.w2Token}`, 'x-request-id': REQUEST_ID },
               })
            ).json()) as { workspaces: { id: string }[] };
            assert.deepEqual(pluginContext.workspaces.map((w) => w.id), [world.w2Id]);

            // (d) No credential is 401 on both mounts.
            const anonymous = await app.request(`/api/v1/plugins/${world.w1Id}/installations`, {
               headers: { 'x-request-id': REQUEST_ID },
            });
            assert.equal(anonymous.status, 401);
            assert.equal((await app.request('/v1/context', { headers: { 'x-request-id': REQUEST_ID } })).status, 401);
         }
      );

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

      // ------------------------------------------------ GitHub (workstream K)

      test(
         'GitHub: a W1 member never sees, reads or changes W2’s GitHub settings or repositories',
         async () => {
            // (a) W1's repository list carries W1's row and never W2's.
            const listed = (await (
               await getAsU1(`/api/v1/github/${world.w1Id}/repositories`)
            ).json()) as { repositories: Array<{ id: string; url: string }> };
            assert.ok(listed.repositories.some((row) => row.url === world.w1RepoUrl));
            assert.ok(
               !listed.repositories.some((row) => row.id === world.w2RepoId || row.url === world.w2RepoUrl),
               'a W2 repository must not appear under W1'
            );

            // (b) Every GitHub read under W2 is the byte-identical 404 of a
            // workspace that does not exist.
            for (const path of [
               'settings',
               'repositories',
               'accounts',
               `issues/${randomUUID()}/pull-requests`,
            ]) {
               const foreign = await getAsU1(`/api/v1/github/${world.w2Id}/${path}`);
               const missing = await getAsU1(`/api/v1/github/${RANDOM_WORKSPACE}/${path}`);
               assert.equal(foreign.status, 404, `${path} under W2 is 404`);
               assert.equal(await foreign.text(), await missing.text(), `${path}: 404s match`);
            }

            // (c) Writing W2's settings is 404 and W2 keeps GitHub off.
            const flipped = await patchAsU1(`/api/v1/github/${world.w2Id}/settings`, { enabled: true });
            assert.equal(flipped.status, 404);
            const [w2Settings] = await sql`
               SELECT enabled FROM github_workspace_settings WHERE workspace_id = ${world.w2Id}`;
            assert.equal(w2Settings?.enabled, false, 'W2 settings are unchanged');

            // A W2 repository id under W1's own scope is as absent as a random id.
            const crossed = await patchAsU1(
               `/api/v1/github/${world.w1Id}/repositories/${world.w2RepoId}`,
               { description: 'hijacked' }
            );
            const random = await patchAsU1(
               `/api/v1/github/${world.w1Id}/repositories/${randomUUID()}`,
               { description: 'hijacked' }
            );
            assert.equal(crossed.status, 404);
            assert.equal(await crossed.text(), await random.text());
            const [w2Repo] = await sql`
               SELECT description FROM workspace_repositories WHERE id = ${world.w2RepoId}`;
            assert.equal(w2Repo?.description, '', 'W2 repository is unchanged');

            // (d) No session, no GitHub route.
            const anonymous = await Promise.resolve(
               app.request(`/api/v1/github/${world.w1Id}/settings`, {
                  headers: { 'x-request-id': REQUEST_ID },
               })
            );
            assert.equal(anonymous.status, 401);
         }
      );

      test(
         'GitHub: an installation belongs to one workspace — W1 cannot see or disconnect W2’s',
         async () => {
            // (a) W1's own accounts never name W2's installation. Read as the
            // owner, who is the only role allowed to ask.
            const listed = await getAsU1(`/api/v1/github/${world.w1Id}/accounts`);
            assert.equal(listed.status, 200);
            const body = await listed.text();
            assert.equal(
               body.includes(String(world.w2InstallationId)),
               false,
               'W2’s installation must not appear under W1'
            );

            // (c) Disconnecting it is the same 404 whether it is addressed
            // under W1's own scope or under W2's, and the row survives both.
            for (const workspaceId of [world.w1Id, world.w2Id]) {
               const refused = await deleteAsU1(
                  `/api/v1/github/${workspaceId}/accounts/${world.w2InstallationId}`
               );
               assert.equal(refused.status, 404, workspaceId);
            }
            const [row] = await sql`
               SELECT workspace_id FROM github_installations
                WHERE installation_id = ${world.w2InstallationId}`;
            assert.equal(row?.workspace_id, world.w2Id, 'W2 keeps its installation');
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
