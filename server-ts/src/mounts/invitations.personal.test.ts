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
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { secretsMounts } from './secrets.ts';

/**
 * The invitations a person has been sent, as their own page has to show them.
 *
 * An invitee is by definition not a member of the workspace yet, so they
 * cannot look its name up — without it the list can only offer a uuid, which
 * is not something anyone can accept or decline on. The name therefore travels
 * on the invitation itself.
 *
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const SETTINGS = { issuePrefix: 'INV', defaultRole: 'member', allowMemberInvites: false };

describe(
   '/api/v1/invitations names the workspace it invites you to',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: ReturnType<typeof createApp>;
      let ownerId = '';
      let inviteeId = '';
      let strangerId = '';
      let workspaceId = '';
      let workspaceName = '';
      let inviteeToken = '';
      let strangerToken = '';
      let secrets: SecretsRepository;

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);
         workspaceName = `Invited workspace ${suffix}`;
         const inviteeEmail = `invitee-${suffix}@berry.test`;

         const user = async (label: string, email: string) => {
            const [row] = await sql`
               INSERT INTO users (id, email, name)
               VALUES (${randomUUID()}, ${email}, ${`Invitation ${label}`})
               RETURNING id`;
            return (row as { id: string }).id;
         };
         ownerId = await user('owner', `inviter-${suffix}@berry.test`);
         inviteeId = await user('invitee', inviteeEmail);
         strangerId = await user('stranger', `stranger-${suffix}@berry.test`);

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${workspaceName}, ${`inv-${suffix}`},
                    ${sql.json(SETTINGS as never)}, ${ownerId})
            RETURNING id`;
         workspaceId = (workspace as { id: string }).id;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${workspaceId}, ${ownerId}, 'owner')`;

         secrets = new SecretsRepository(sql);
         await secrets.createInvitation({
            actorId: ownerId,
            workspaceId,
            email: inviteeEmail,
            role: 'member',
            expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            idempotencyKey: randomUUID(),
            fingerprint: Buffer.alloc(32, 3),
         });

         inviteeToken = await issueTestToken(sql, inviteeId);
         strangerToken = await issueTestToken(sql, strangerId);

         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         const registry = new Registry();
         registry.registerAll(secretsMounts({ sessions, secrets }));
         app = createApp(registry);
      });

      after(async () => {
         if (!sql) return;
         if (workspaceId) {
            await deleteWorkspaceAgents(sql, [workspaceId]);
         await deleteWorkspaceBoards(sql, [workspaceId]);
            await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
         }
         for (const id of [ownerId, inviteeId, strangerId]) {
            if (!id) continue;
            await sql`DELETE FROM sessions WHERE user_id = ${id}`;
            await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      const listAs = (bearer: string) =>
         Promise.resolve(
            app.request('/api/v1/invitations', { headers: { authorization: `Bearer ${bearer}` } })
         );

      test('the invitee sees the invitation, and it names the workspace', async () => {
         const response = await listAs(inviteeToken);
         assert.equal(response.status, 200);
         const body = (await response.json()) as {
            nodes: Array<{ workspaceId: string; workspaceName: string; role: string }>;
         };
         assert.equal(body.nodes.length, 1);
         assert.equal(body.nodes[0]!.workspaceName, workspaceName);
         assert.equal(body.nodes[0]!.workspaceId, workspaceId);
         assert.equal(body.nodes[0]!.role, 'member');
      });

      test('an invitation addressed to someone else is not listed', async () => {
         const response = await listAs(strangerToken);
         assert.equal(response.status, 200);
         const body = (await response.json()) as { nodes: unknown[] };
         assert.deepEqual(body.nodes, []);
      });

      test('a revoked invitation stops being listed', async () => {
         await secrets.revokeInvitation(
            ownerId,
            workspaceId,
            ((await (await listAs(inviteeToken)).json()) as { nodes: Array<{ id: string }> })
               .nodes[0]!.id
         );
         const response = await listAs(inviteeToken);
         const body = (await response.json()) as { nodes: unknown[] };
         assert.deepEqual(body.nodes, []);
      });
   }
);
