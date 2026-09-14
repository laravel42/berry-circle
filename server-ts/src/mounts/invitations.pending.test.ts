import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp, type BerryApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { SecretsRepository } from '../identity/secrets.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { secretsMounts } from './secrets.ts';

/**
 * Joining and declining an invitation from a list rather than from a link.
 *
 * The link path (`/accept`) proves itself with a token. This path proves
 * itself with the session: the invitation is addressed to the caller's own
 * address, which is the same fact that put it in `/pending`. So the two things
 * worth asserting are that the list shows only your own invitations, and that
 * acting on somebody else's is the same not-found as acting on one that was
 * never there.
 *
 * Database-backed; skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

describe(
   'pending invitations can be joined and declined from the switcher',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: BerryApp;

      let ownerId = '';
      let inviteeId = '';
      let strangerId = '';
      let inviteeToken = '';
      let strangerToken = '';
      let workspaceId = '';
      let inviteeInvitationId = '';
      let strangerInvitationId = '';

      /** An invitation row, written straight in: the API's own create needs an
       *  admin session and an idempotency key, and neither is what is under
       *  test here. */
      async function seedInvitation(email: string): Promise<string> {
         const [row] = await sql`
            INSERT INTO workspace_invitations
               (id, workspace_id, email, role, invited_by, token_hash,
                idempotency_key_hash, request_fingerprint, expires_at)
            VALUES (${randomUUID()}, ${workspaceId}, ${email}, 'member', ${ownerId},
                    ${randomBytes(32)}, ${randomBytes(32)}, ${randomBytes(32)},
                    ${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()})
            RETURNING id`;
         return (row as { id: string }).id;
      }

      const postAs = (bearer: string, path: string) =>
         Promise.resolve(
            app.request(path, {
               method: 'POST',
               headers: {
                  authorization: `Bearer ${bearer}`,
                  'content-type': 'application/json',
                  'Idempotency-Key': randomUUID(),
               },
               body: JSON.stringify({}),
            })
         );

      const getAs = (bearer: string, path: string) =>
         Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${bearer}` } }));

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);

         const [owner] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`inv-owner-${suffix}@berry.test`}, 'Invite Owner')
            RETURNING id, email`;
         const [invitee] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`inv-guest-${suffix}@berry.test`}, 'Invite Guest')
            RETURNING id, email`;
         const [stranger] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`inv-other-${suffix}@berry.test`}, 'Invite Other')
            RETURNING id, email`;
         ownerId = (owner as { id: string }).id;
         inviteeId = (invitee as { id: string }).id;
         strangerId = (stranger as { id: string }).id;

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Invites ${suffix}`}, ${`invites-${suffix}`},
                    ${sql.json({ issuePrefix: 'INV', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${ownerId})
            RETURNING id`;
         workspaceId = (workspace as { id: string }).id;
         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${workspaceId}, ${ownerId}, 'owner')`;

         inviteeInvitationId = await seedInvitation((invitee as { email: string }).email);
         strangerInvitationId = await seedInvitation((stranger as { email: string }).email);

         const sessions = new SessionService({
            sql,
            auth: null,
            bearer: [personalTokenResolver(sql)],
         });
         inviteeToken = await issueTestToken(sql, inviteeId);
         strangerToken = await issueTestToken(sql, strangerId);

         const registry = new Registry();
         registry.registerAll(secretsMounts({ sessions, secrets: new SecretsRepository(sql) }));
         app = createApp(registry);
      });

      after(async () => {
         if (!sql) return;
         if (workspaceId) {
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${workspaceId}`;
            await deleteWorkspaceAgents(sql, [workspaceId]);
            await deleteWorkspaceBoards(sql, [workspaceId]);
            await sql`DELETE FROM workspace_invitations WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM issue_status_definitions WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${workspaceId}`;
            await sql`DELETE FROM workspaces WHERE id = ${workspaceId}`;
         }
         for (const id of [ownerId, inviteeId, strangerId]) {
            if (id) await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      test('the list carries the workspace name and only this account’s invitations', async () => {
         const response = await getAs(inviteeToken, '/api/v1/invitations/pending');
         assert.equal(response.status, 200);
         const body = (await response.json()) as {
            nodes: { id: string; workspaceId: string; workspaceName: string; role: string }[];
         };
         assert.equal(body.nodes.length, 1);
         assert.equal(body.nodes[0]!.id, inviteeInvitationId);
         assert.equal(body.nodes[0]!.workspaceId, workspaceId);
         assert.ok(body.nodes[0]!.workspaceName.startsWith('Invites '));
         assert.equal(body.nodes[0]!.role, 'member');
         // Somebody else's invitation to the same workspace is not in it.
         assert.equal(
            body.nodes.some((node) => node.id === strangerInvitationId),
            false
         );
      });

      test('someone else’s invitation is the same 404 as one that never existed', async () => {
         const foreign = await postAs(inviteeToken, `/api/v1/invitations/${strangerInvitationId}/join`);
         const absent = await postAs(inviteeToken, `/api/v1/invitations/${randomUUID()}/join`);
         assert.equal(foreign.status, 404);
         assert.equal(absent.status, 404);

         const declineForeign = await postAs(
            inviteeToken,
            `/api/v1/invitations/${strangerInvitationId}/decline`
         );
         assert.equal(declineForeign.status, 404);

         // And the row it could not touch is untouched.
         const [row] = await sql`
            SELECT accepted_at, revoked_at FROM workspace_invitations
             WHERE id = ${strangerInvitationId}`;
         assert.equal(row!.accepted_at, null);
         assert.equal(row!.revoked_at, null);
         const [membership] = await sql`
            SELECT 1 FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${inviteeId}`;
         assert.equal(membership, undefined);
      });

      test('declining retires the invitation and takes it out of the list', async () => {
         const response = await postAs(
            strangerToken,
            `/api/v1/invitations/${strangerInvitationId}/decline`
         );
         assert.equal(response.status, 204);

         const [row] = await sql`
            SELECT accepted_at, revoked_at FROM workspace_invitations
             WHERE id = ${strangerInvitationId}`;
         assert.equal(row!.accepted_at, null);
         assert.notEqual(row!.revoked_at, null);

         const listed = await getAs(strangerToken, '/api/v1/invitations/pending');
         const body = (await listed.json()) as { nodes: unknown[] };
         assert.equal(body.nodes.length, 0);

         // Declining is final: a second attempt has nothing left to act on.
         const again = await postAs(
            strangerToken,
            `/api/v1/invitations/${strangerInvitationId}/decline`
         );
         assert.equal(again.status, 404);
      });

      test('joining creates the membership and empties the list', async () => {
         const response = await postAs(inviteeToken, `/api/v1/invitations/${inviteeInvitationId}/join`);
         assert.equal(response.status, 200);
         const member = (await response.json()) as { workspaceId: string; role: string };
         assert.equal(member.workspaceId, workspaceId);
         assert.equal(member.role, 'member');

         const [membership] = await sql`
            SELECT role::text AS role FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${inviteeId}`;
         assert.equal(membership!.role, 'member');

         const [row] = await sql`
            SELECT accepted_at, accepted_by FROM workspace_invitations
             WHERE id = ${inviteeInvitationId}`;
         assert.notEqual(row!.accepted_at, null);
         assert.equal(row!.accepted_by, inviteeId);

         const listed = await getAs(inviteeToken, '/api/v1/invitations/pending');
         const body = (await listed.json()) as { nodes: unknown[] };
         assert.equal(body.nodes.length, 0);

         // Joining again is the same membership, not a second one or an error:
         // the person asked to be in the workspace, and they are.
         const repeat = await postAs(inviteeToken, `/api/v1/invitations/${inviteeInvitationId}/join`);
         assert.equal(repeat.status, 200);
         const rows = await sql`
            SELECT user_id FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${inviteeId}`;
         assert.equal(rows.length, 1);
      });
   }
);
