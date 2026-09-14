// Feature: auth-and-tenant-isolation, Property 11: Invitation acceptance is
// single-use and idempotent for the invitee.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import fc from 'fast-check';

import { closeDatabase, openDatabase, type Sql } from '../db/pool.ts';
import { InvitationInvalid } from './errors.ts';
import { INVITATION_TOKEN_PREFIX, SecretsRepository } from './secrets.ts';
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
 * The property: `SecretsRepository.acceptInvitation` is single-use and
 * idempotent for the invitee. A VALID invitation issued to the caller's own
 * identity, accepted once or many times, leaves EXACTLY ONE membership in the
 * workspace carrying the invitation's role — a repeat accept is the invitee's
 * own membership, never a second row. Every INVALID presentation — expired,
 * revoked, already accepted by another identity, or addressed to a different
 * email — is refused with `InvitationInvalid` (the wire's 404
 * `INVITATION_INVALID`) and creates ZERO memberships (Requirements 10.6, 10.7,
 * 10.8).
 *
 * Each invitation state is crafted by inserting a `workspace_invitations` row
 * directly, so the raw token is known: the token is `berry_inv_` + a 43-char
 * unpadded-base64url secret (32 random bytes), and `token_hash` is the SHA-256
 * of the FULL token. The distinguishing column per state:
 *   - valid:          expires in the future, `revoked_at`/`accepted_at` null,
 *                     `email` = the invitee's.
 *   - expired:        `expires_at` already in the past.
 *   - revoked:        `revoked_at` set.
 *   - alreadyAccepted: `accepted_at`/`accepted_by` set to a DIFFERENT user, so
 *                     the invitee replaying it is a stolen token, not a replay.
 *   - wrongIdentity:  `email` = a different user's, so the invitation was never
 *                     issued to the accepting identity.
 */

const url = process.env.BERRY_TEST_DATABASE_URL;

// Each iteration inserts an invitation, runs one-to-many real accepts under a
// row lock, then counts memberships — hold the run at the ≥100 floor the
// property suite requires.
const RUNS = 100;

/** The invitation states the property ranges over. */
const STATES = ['valid', 'expired', 'revoked', 'alreadyAccepted', 'wrongIdentity'] as const;
type State = (typeof STATES)[number];

/** The invitation's role — anything but `owner`, which the schema forbids. */
const INVITATION_ROLE = 'admin';

/** Mints a well-formed invitation token and the digest the row must store. */
function mintToken(): { token: string; tokenHash: Buffer } {
   const secret = randomBytes(32).toString('base64url');
   const token = INVITATION_TOKEN_PREFIX + secret;
   return { token, tokenHash: createHash('sha256').update(token).digest() };
}

describe(
   'Feature: auth-and-tenant-isolation, Property 11: Invitation acceptance is single-use and idempotent for the invitee',
   { skip: url ? false : 'BERRY_TEST_DATABASE_URL is not set' },
   () => {
      let sql: Sql;
      let secrets: SecretsRepository;

      // The seeded truth. `inviteeId` is the identity that accepts, and
      // `inviteeEmail` is the address a VALID invitation must carry. `inviterId`
      // is the workspace owner who issued the invitations. `strangerId` /
      // `strangerEmail` is a second identity used for the adversarial states:
      // the `wrongIdentity` invitation is addressed to the stranger, and the
      // `alreadyAccepted` invitation was consumed by the stranger.
      const fixture: Record<string, string> = {};

      before(async () => {
         sql = openDatabase({ url: url as string });
         secrets = new SecretsRepository(sql);
         const suffix = randomUUID().slice(0, 8);

         const inviteeEmail = `inv-prop11-invitee-${suffix}@berry.test`;
         const [invitee] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${inviteeEmail}, 'Invitation Property 11 Invitee')
            RETURNING id`;
         fixture.inviteeId = invitee!.id as string;
         fixture.inviteeEmail = inviteeEmail;

         const strangerEmail = `inv-prop11-stranger-${suffix}@berry.test`;
         const [stranger] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${strangerEmail}, 'Invitation Property 11 Stranger')
            RETURNING id`;
         fixture.strangerId = stranger!.id as string;
         fixture.strangerEmail = strangerEmail;

         // The inviter owns the workspace and is the `invited_by` for every
         // seeded invitation. Kept out of the invitee's workspace so membership
         // counts reflect only what acceptInvitation creates.
         const [inviter] = await sql`
            INSERT INTO users (id, email, name)
            VALUES (${randomUUID()}, ${`inv-prop11-inviter-${suffix}@berry.test`},
                    'Invitation Property 11 Inviter')
            RETURNING id`;
         fixture.inviterId = inviter!.id as string;

         const [workspace] = await sql`
            INSERT INTO workspaces (id, name, slug, settings, created_by)
            VALUES (${randomUUID()}, ${`Inv ${suffix}`}, ${`inv-${suffix}`},
                    ${sql.json({ issuePrefix: 'INV', defaultRole: 'member', allowMemberInvites: false } as never)},
                    ${fixture.inviterId})
            RETURNING id`;
         fixture.workspaceId = workspace!.id as string;

         await sql`
            INSERT INTO workspace_memberships (workspace_id, user_id, role)
            VALUES (${fixture.workspaceId}, ${fixture.inviterId}, 'owner')`;
      });

      after(async () => {
         if (fixture.workspaceId) {
            // A workspace provisions a protected Orchestrator agent by trigger,
            // and protected agents refuse deletion. The shared helper clears and
            // deletes it inside one transaction.
            await sql`DELETE FROM outbox_events WHERE workspace_id = ${fixture.workspaceId}`;
            await deleteWorkspaceAgents(sql, [fixture.workspaceId]);
            await deleteWorkspaceBoards(sql, [fixture.workspaceId]);
            await sql`DELETE FROM workspace_invitations WHERE workspace_id = ${fixture.workspaceId}`;
            await sql`DELETE FROM workspace_memberships WHERE workspace_id = ${fixture.workspaceId}`;
            await sql`DELETE FROM workspaces WHERE id = ${fixture.workspaceId}`;
         }
         for (const id of [fixture.inviteeId, fixture.strangerId, fixture.inviterId]) {
            if (id) await sql`DELETE FROM users WHERE id = ${id}`;
         }
         await closeDatabase(sql);
      });

      /** How many memberships the invitee holds in the seeded workspace. */
      async function inviteeMembershipCount(): Promise<number> {
         const [row] = await sql`
            SELECT count(*)::int AS n
              FROM workspace_memberships
             WHERE workspace_id = ${fixture.workspaceId!} AND user_id = ${fixture.inviteeId!}`;
         return (row!.n as number) ?? 0;
      }

      /**
       * Inserts one invitation in `state` and returns its id and raw token.
       *
       * The 32-byte digest columns other than `token_hash` are unrelated to
       * acceptance, so they carry throwaway random bytes that only satisfy the
       * NOT NULL / octet_length checks.
       */
      async function seedInvitation(state: State): Promise<{ id: string; token: string }> {
         const { token, tokenHash } = mintToken();
         const id = randomUUID();
         const filler = randomBytes(32);

         const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
         const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
         const created = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

         // Only a VALID invitation must be addressed to the accepting identity;
         // `wrongIdentity` is addressed to the stranger instead.
         const email = state === 'wrongIdentity' ? fixture.strangerEmail! : fixture.inviteeEmail!;
         // `expired` lapses in the past; every other state stays live so the
         // rejection it drives is the one under test, not incidental expiry.
         const expiresAt = state === 'expired' ? past : future;
         const revokedAt = state === 'revoked' ? past : null;
         // `alreadyAccepted` was consumed by the STRANGER, so the invitee
         // replaying it presents a token that belongs to someone else. The two
         // columns are both-or-neither per the schema check.
         const acceptedAt = state === 'alreadyAccepted' ? past : null;
         const acceptedBy = state === 'alreadyAccepted' ? fixture.strangerId! : null;

         await sql`
            INSERT INTO workspace_invitations (
               id, workspace_id, email, role, invited_by, token_hash,
               idempotency_key_hash, request_fingerprint, expires_at,
               accepted_at, accepted_by, revoked_at, created_at
            ) VALUES (
               ${id}, ${fixture.workspaceId!}, ${email}, ${INVITATION_ROLE}, ${fixture.inviterId!},
               ${tokenHash}, ${filler}, ${filler}, ${expiresAt},
               ${acceptedAt}, ${acceptedBy}, ${revokedAt}, ${created}
            )`;
         return { id, token };
      }

      /** Removes the per-iteration invitation and any membership it created. */
      async function resetIteration(invitationId: string): Promise<void> {
         await sql`DELETE FROM workspace_invitations WHERE id = ${invitationId}`;
         await sql`
            DELETE FROM workspace_memberships
             WHERE workspace_id = ${fixture.workspaceId!} AND user_id = ${fixture.inviteeId!}`;
      }

      test(
         'Feature: auth-and-tenant-isolation, Property 11: valid invitations accept to exactly one membership (idempotent on repeat), and expired/revoked/already-accepted/wrong-identity invitations are rejected with InvitationInvalid and create zero memberships',
         async () => {
            await fc.assert(
               fc.asyncProperty(
                  fc.constantFrom(...STATES),
                  // How many times the invitee presents the token. One or more,
                  // so idempotence is exercised: a valid invitation accepted
                  // repeatedly must still yield a single membership.
                  fc.integer({ min: 1, max: 4 }),
                  async (state, attempts) => {
                     const { id, token } = await seedInvitation(state);
                     try {
                        // The invitee always begins with no membership; a
                        // leftover would make the count meaningless.
                        assert.equal(
                           await inviteeMembershipCount(),
                           0,
                           'invitee must start each iteration with no membership'
                        );

                        if (state === 'valid') {
                           // Every accept must succeed and return the invitee's
                           // membership carrying the invitation's role.
                           for (let attempt = 0; attempt < attempts; attempt += 1) {
                              const membership = await secrets.acceptInvitation(
                                 fixture.inviteeId!,
                                 id,
                                 token
                              );
                              assert.equal(
                                 membership.workspaceId,
                                 fixture.workspaceId,
                                 'membership must be in the invitation workspace'
                              );
                              assert.equal(
                                 membership.userId,
                                 fixture.inviteeId,
                                 'membership must belong to the accepting invitee'
                              );
                              assert.equal(
                                 membership.role,
                                 INVITATION_ROLE,
                                 "membership must carry the invitation's role"
                              );
                           }
                           // The oracle: one-or-more accepts of a valid
                           // invitation leave EXACTLY ONE membership.
                           assert.equal(
                              await inviteeMembershipCount(),
                              1,
                              'a valid invitation accepted one-or-more times yields exactly one membership'
                           );
                        } else {
                           // Every invalid presentation, however many times,
                           // is rejected with InvitationInvalid (→ 404
                           // INVITATION_INVALID) and never a membership.
                           for (let attempt = 0; attempt < attempts; attempt += 1) {
                              await assert.rejects(
                                 secrets.acceptInvitation(fixture.inviteeId!, id, token),
                                 (error) => error instanceof InvitationInvalid,
                                 `${state} invitation must be rejected with InvitationInvalid`
                              );
                           }
                           assert.equal(
                              await inviteeMembershipCount(),
                              0,
                              `${state} invitation must create no membership`
                           );
                        }
                     } finally {
                        await resetIteration(id);
                     }
                  }
               ),
               { numRuns: RUNS }
            );
         }
      );
   }
);
