import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { WorkspaceRepository } from '../identity/workspaces.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { workspaceMounts } from './workspaces.ts';

/**
 * What the workspace "General" page needs: a logo address, the standing
 * context every agent here is given, and a way out of a workspace.
 *
 * Leaving is the part worth the most care. Removing *someone else* needs
 * `members.manage`, which a plain member does not have, so leaving cannot be
 * that call — but the last-owner rule still has to hold, or a workspace ends
 * up with nobody who can administer it.
 *
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const SETTINGS = { issuePrefix: 'ADM', defaultRole: 'member', allowMemberInvites: false };

describe(
   'workspace general settings and leaving a workspace',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: ReturnType<typeof createApp>;
      /** owner of W1, alongside a second owner so they are never the last one. */
      let ownerId = '';
      let secondOwnerId = '';
      let memberId = '';
      /** Sole owner of W2, and a stranger to W1. */
      let strangerId = '';
      let w1 = '';
      let w2 = '';
      const token: Record<string, string> = {};

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);

         const user = async (label: string) => {
            const [row] = await sql`
               INSERT INTO users (id, email, name)
               VALUES (${randomUUID()}, ${`wsadmin-${label}-${suffix}@berry.test`}, ${`WS ${label}`})
               RETURNING id`;
            return (row as { id: string }).id;
         };
         ownerId = await user('owner');
         secondOwnerId = await user('second');
         memberId = await user('member');
         strangerId = await user('stranger');

         const workspace = async (label: string, creator: string) => {
            const [row] = await sql`
               INSERT INTO workspaces (id, name, slug, settings, created_by)
               VALUES (${randomUUID()}, ${`WS ${label} ${suffix}`}, ${`ws-${label}-${suffix}`},
                       ${sql.json(SETTINGS as never)}, ${creator})
               RETURNING id`;
            return (row as { id: string }).id;
         };
         w1 = await workspace('one', ownerId);
         w2 = await workspace('two', strangerId);

         const member = (workspaceId: string, userId: string, role: string) => sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${workspaceId}, ${userId}, ${role})`;
         await member(w1, ownerId, 'owner');
         await member(w1, secondOwnerId, 'owner');
         await member(w1, memberId, 'member');
         await member(w2, strangerId, 'owner');

         for (const [label, id] of [
            ['owner', ownerId],
            ['second', secondOwnerId],
            ['member', memberId],
            ['stranger', strangerId],
         ] as const) {
            token[label] = await issueTestToken(sql, id);
         }

         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         const registry = new Registry();
         registry.registerAll(
            workspaceMounts({
               sessions,
               workspaces: new WorkspaceRepository(sql),
               secrets: new SecretsRepository(sql),
            })
         );
         app = createApp(registry);
      });

      after(async () => {
         if (!sql) return;
         // Inserting a workspace seeds its protected orchestrator, and
         // `agents.workspace_id` is RESTRICT rather than CASCADE, so the agents
         // have to go before the workspace can.
         await deleteWorkspaceAgents(sql, [w1, w2]);
         await deleteWorkspaceBoards(sql, [w1, w2]);
         for (const id of [w1, w2]) {
            if (id) await sql`DELETE FROM workspaces WHERE id = ${id}`;
         }
         for (const id of [ownerId, secondOwnerId, memberId, strangerId]) {
            if (!id) continue;
            await sql`DELETE FROM sessions WHERE user_id = ${id}`;
            await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      const call = (who: string, path: string, init: RequestInit = {}) =>
         Promise.resolve(
            app.request(path, {
               ...init,
               headers: { authorization: `Bearer ${token[who]}`, 'content-type': 'application/json' },
            })
         );
      const patchW1 = (who: string, body: unknown) =>
         call(who, `/api/v1/workspaces/${w1}`, { method: 'PATCH', body: JSON.stringify(body) });

      test('a workspace that has set neither reads both as null', async () => {
         const response = await call('owner', `/api/v1/workspaces/${w1}`);
         assert.equal(response.status, 200);
         const body = (await response.json()) as { logoUrl: unknown; agentContext: unknown };
         assert.equal(body.logoUrl, null);
         assert.equal(body.agentContext, null);
      });

      test('an owner sets the logo and the agent context', async () => {
         const response = await patchW1('owner', {
            logoUrl: 'https://example.test/mark.png',
            agentContext: '  We deploy on Fridays. Ask before touching billing.  ',
         });
         assert.equal(response.status, 200);
         const body = (await response.json()) as { logoUrl: string; agentContext: string };
         assert.equal(body.logoUrl, 'https://example.test/mark.png');
         assert.equal(body.agentContext, 'We deploy on Fridays. Ask before touching billing.');
      });

      test('the context survives an unrelated patch, and a blank clears it', async () => {
         const renamed = await patchW1('owner', { name: 'Renamed workspace' });
         assert.equal(renamed.status, 200);
         assert.equal(
            ((await renamed.json()) as { agentContext: string }).agentContext,
            'We deploy on Fridays. Ask before touching billing.'
         );

         const blanked = await patchW1('owner', { agentContext: '   ' });
         assert.equal(blanked.status, 200);
         // Emptying the box means "this workspace has no standing instruction",
         // not "its instruction is the empty string".
         assert.equal(((await blanked.json()) as { agentContext: unknown }).agentContext, null);
      });

      test('an over-long context is refused and nothing is stored', async () => {
         await patchW1('owner', { agentContext: 'Kept.' });

         const refused = await patchW1('owner', { agentContext: 'x'.repeat(10_001) });
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /"\/agentContext"/);

         const unchanged = await call('owner', `/api/v1/workspaces/${w1}`);
         assert.equal(((await unchanged.json()) as { agentContext: string }).agentContext, 'Kept.');
      });

      test('a logo that is not an absolute HTTP(S) URL is refused', async () => {
         for (const bad of ['mark.png', 'javascript:alert(1)', 'https://user:pw@example.test/a.png']) {
            const refused = await patchW1('owner', { logoUrl: bad });
            assert.equal(refused.status, 422, bad);
            assert.match(await refused.text(), /"\/logoUrl"/);
         }
         const unchanged = await call('owner', `/api/v1/workspaces/${w1}`);
         assert.equal(
            ((await unchanged.json()) as { logoUrl: string }).logoUrl,
            'https://example.test/mark.png'
         );
      });

      test('an explicit null clears the logo', async () => {
         const cleared = await patchW1('owner', { logoUrl: null });
         assert.equal(cleared.status, 200);
         assert.equal(((await cleared.json()) as { logoUrl: unknown }).logoUrl, null);
      });

      test('a patch naming none of the fields is still refused', async () => {
         const refused = await patchW1('owner', {});
         assert.equal(refused.status, 422);
         assert.match(await refused.text(), /empty_patch/);
      });

      test('a member cannot change them, and a stranger cannot see the workspace', async () => {
         const forbidden = await patchW1('member', { agentContext: 'Mine now.' });
         assert.equal(forbidden.status, 403);

         // A non-member gets the same 404 an absent workspace does, so the
         // refusal never confirms the workspace exists.
         const invisible = await call('stranger', `/api/v1/workspaces/${w1}`);
         assert.equal(invisible.status, 404);
         const absent = await call('stranger', `/api/v1/workspaces/${randomUUID()}`);
         assert.equal(absent.status, 404);
      });

      test('the agents on a member\'s work are readable by the workspace, and nobody else', async () => {
         const mine = await call('member', `/api/v1/workspaces/${w1}/members/${memberId}/top-agents`);
         assert.equal(mine.status, 200);
         // Nothing has run here, and an empty list is the honest answer rather
         // than an absence of the route.
         assert.deepEqual((await mine.json()) as unknown, { nodes: [] });

         // Someone who is not in W1 gets the same 404 for a real member of it
         // as they would for a workspace that does not exist, so the route
         // cannot be used to confirm that either exists.
         const outsider = await call(
            'stranger',
            `/api/v1/workspaces/${w1}/members/${memberId}/top-agents`
         );
         assert.equal(outsider.status, 404);

         // And a member of W1 asking about somebody who is not in W1 is told
         // the same thing: a membership they cannot see is not a fact about
         // that person's agents.
         const foreign = await call(
            'member',
            `/api/v1/workspaces/${w1}/members/${strangerId}/top-agents`
         );
         assert.equal(foreign.status, 404);
      });

      test('a member can leave, and afterwards the workspace is not theirs to see', async () => {
         await sql`
            UPDATE users SET last_workspace_id = ${w1} WHERE id = ${memberId}`;

         const left = await call('member', `/api/v1/workspaces/${w1}/leave`, { method: 'POST' });
         assert.equal(left.status, 204);

         const gone = await call('member', `/api/v1/workspaces/${w1}`);
         assert.equal(gone.status, 404);
         const [row] = await sql`SELECT last_workspace_id FROM users WHERE id = ${memberId}`;
         // Nobody may be left pointing at a workspace they can no longer read.
         assert.equal((row as { last_workspace_id: string | null }).last_workspace_id, null);
      });

      test('the sole owner cannot leave', async () => {
         const refused = await call('stranger', `/api/v1/workspaces/${w2}/leave`, {
            method: 'POST',
         });
         assert.equal(refused.status, 409);
         assert.match(await refused.text(), /LAST_OWNER_REQUIRED/);

         const [row] = await sql`
            SELECT count(*)::int AS count FROM workspace_memberships
             WHERE workspace_id = ${w2} AND user_id = ${strangerId}`;
         assert.equal((row as { count: number }).count, 1);
      });

      test('an owner may leave while another owner remains', async () => {
         const left = await call('owner', `/api/v1/workspaces/${w1}/leave`, { method: 'POST' });
         assert.equal(left.status, 204);

         const [row] = await sql`
            SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = ${w1}`;
         assert.equal((row as { count: number }).count, 1);
      });

      test('leaving a workspace you are not in is the same 404 as one that is not there', async () => {
         const notAMember = await call('stranger', `/api/v1/workspaces/${w1}/leave`, {
            method: 'POST',
         });
         assert.equal(notAMember.status, 404);

         const absent = await call('stranger', `/api/v1/workspaces/${randomUUID()}/leave`, {
            method: 'POST',
         });
         assert.equal(absent.status, 404);
      });
   }
);
