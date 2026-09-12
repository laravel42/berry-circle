import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { personalTokenResolver } from '../auth/credentials.ts';
import { SessionService } from '../auth/sessions.ts';
import { issueTestToken } from '../auth/test-credentials.ts';
import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { createApp } from '../http/app.ts';
import { Registry } from '../http/registry.ts';
import { INVITATION_TOKEN_PREFIX, SecretsRepository } from '../identity/secrets.ts';
import { deleteWorkspaceBoards } from '../test-support/boards.ts';
import { deleteWorkspaceAgents } from '../test-support/protected-agents.ts';
import { secretsMounts } from './secrets.ts';

/**
 * Accepting an invitation, with and without its token.
 *
 * The token is what proves an invitation reached the person holding the link.
 * It became optional so that someone can accept the invitations waiting for
 * them from a list, which never held any tokens — but that is only sound while
 * the address still decides who may accept. These tests pin exactly that: the
 * address is always required, a supplied token must still be genuine, and
 * neither relaxation lets a stranger in.
 *
 * Database-backed, so it skips without BERRY_TEST_DATABASE_URL.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

const SETTINGS = { issuePrefix: 'ACC', defaultRole: 'member', allowMemberInvites: false };

/** Correctly shaped (10-char prefix + 43-char secret) but not any real token. */
const WRONG_TOKEN = `${INVITATION_TOKEN_PREFIX}${'A'.repeat(43)}`;

describe(
   'accepting an invitation is decided by the address, not only the token',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let app: ReturnType<typeof createApp>;
      let ownerId = '';
      let inviteeId = '';
      let strangerId = '';
      let w1 = '';
      let w2 = '';
      let firstInvitation = '';
      let secondInvitation = '';
      let secondToken = '';
      let inviteeBearer = '';
      let strangerBearer = '';

      before(async () => {
         sql = openDatabase({ url: url as string });
         const suffix = randomUUID().slice(0, 8);
         const inviteeEmail = `accept-invitee-${suffix}@berry.test`;

         const user = async (label: string, email: string) => {
            const [row] = await sql`
               INSERT INTO users (id, email, name)
               VALUES (${randomUUID()}, ${email}, ${`Accept ${label}`})
               RETURNING id`;
            return (row as { id: string }).id;
         };
         ownerId = await user('owner', `accept-owner-${suffix}@berry.test`);
         inviteeId = await user('invitee', inviteeEmail);
         strangerId = await user('stranger', `accept-stranger-${suffix}@berry.test`);

         const workspace = async (label: string) => {
            const [row] = await sql`
               INSERT INTO workspaces (id, name, slug, settings, created_by)
               VALUES (${randomUUID()}, ${`Accept ${label} ${suffix}`}, ${`acc-${label}-${suffix}`},
                       ${sql.json(SETTINGS as never)}, ${ownerId})
               RETURNING id`;
            const id = (row as { id: string }).id;
            await sql`
               INSERT INTO workspace_memberships (workspace_id, user_id, role)
               VALUES (${id}, ${ownerId}, 'owner')`;
            return id;
         };
         w1 = await workspace('one');
         w2 = await workspace('two');

         const secrets = new SecretsRepository(sql);
         const invite = async (workspaceId: string) =>
            secrets.createInvitation({
               actorId: ownerId,
               workspaceId,
               email: inviteeEmail,
               role: 'member',
               expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
               idempotencyKey: randomUUID(),
               fingerprint: Buffer.alloc(32, 5),
            });
         const first = await invite(w1);
         const second = await invite(w2);
         firstInvitation = first.invitation.id;
         secondInvitation = second.invitation.id;
         secondToken = second.token;

         inviteeBearer = await issueTestToken(sql, inviteeId);
         strangerBearer = await issueTestToken(sql, strangerId);

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
         const ids = [w1, w2].filter(Boolean);
         if (ids.length > 0) {
            await deleteWorkspaceAgents(sql, ids);
            await deleteWorkspaceBoards(sql, ids);
            for (const id of ids) await sql`DELETE FROM workspaces WHERE id = ${id}`;
         }
         for (const id of [ownerId, inviteeId, strangerId]) {
            if (!id) continue;
            await sql`DELETE FROM sessions WHERE user_id = ${id}`;
            await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      const accept = (bearer: string, invitationId: string, body: unknown) =>
         Promise.resolve(
            app.request(`/api/v1/invitations/${invitationId}/accept`, {
               method: 'POST',
               headers: {
                  'authorization': `Bearer ${bearer}`,
                  'content-type': 'application/json',
                  'idempotency-key': randomUUID(),
               },
               body: JSON.stringify(body),
            })
         );

      const membershipCount = async (workspaceId: string, userId: string) => {
         const [row] = await sql`
            SELECT count(*)::int AS count FROM workspace_memberships
             WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`;
         return (row as { count: number }).count;
      };

      test('a stranger cannot accept an invitation addressed to someone else', async () => {
         // Without a token, and — the case that matters — *with* the genuine
         // one: holding the link is not enough when the address is not yours.
         for (const body of [{}, { token: secondToken }]) {
            const refused = await accept(strangerBearer, secondInvitation, body);
            assert.equal(refused.status, 404, JSON.stringify(body));
         }
         assert.equal(await membershipCount(w2, strangerId), 0);
      });

      test('the invited account accepts without a token', async () => {
         const accepted = await accept(inviteeBearer, firstInvitation, {});
         assert.equal(accepted.status, 200);
         const member = (await accepted.json()) as { workspaceId: string; role: string };
         assert.equal(member.workspaceId, w1);
         assert.equal(member.role, 'member');
         assert.equal(await membershipCount(w1, inviteeId), 1);
      });

      test('accepting the same invitation again returns the membership it made', async () => {
         const again = await accept(inviteeBearer, firstInvitation, {});
         assert.equal(again.status, 200);
         assert.equal(((await again.json()) as { workspaceId: string }).workspaceId, w1);
         assert.equal(await membershipCount(w1, inviteeId), 1);
      });

      test('a token that is supplied must still be the real one', async () => {
         const refused = await accept(inviteeBearer, secondInvitation, { token: WRONG_TOKEN });
         assert.equal(refused.status, 404);
         assert.equal(await membershipCount(w2, inviteeId), 0);

         // A token of the wrong shape never reaches the lookup.
         const malformed = await accept(inviteeBearer, secondInvitation, { token: 'nope' });
         assert.equal(malformed.status, 422);
         assert.equal(await membershipCount(w2, inviteeId), 0);
      });

      test('the genuine token still works', async () => {
         const accepted = await accept(inviteeBearer, secondInvitation, { token: secondToken });
         assert.equal(accepted.status, 200);
         assert.equal(await membershipCount(w2, inviteeId), 1);
      });

      test('an invitation that does not exist is the same 404', async () => {
         const absent = await accept(inviteeBearer, randomUUID(), {});
         assert.equal(absent.status, 404);
      });
   }
);
