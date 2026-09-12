import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import {
   Conflict,
   Forbidden,
   IdempotencyConflict,
   InvitationInvalid,
   NotFound,
} from './errors.ts';
import { allows } from './roles.ts';
import { generatePersonalToken, generateToken, parseAuthorization } from '../auth/tokens.ts';
import type { TimeCursor } from '../http/cursor.ts';
import type { ApiScope } from '../public-api/scopes.ts';
import type { Membership } from './workspaces.ts';

/**
 * Personal access tokens and workspace invitations.
 *
 * Neither secret is ever stored. A personal token keeps an indexed public
 * half and the SHA-256 of its secret; an invitation keeps only the digest of
 * its token. A replayed create returns the metadata and deliberately not the
 * secret — it exists once, in the response to the request that made it.
 */

const PERSONAL_TOKEN_COLUMNS = `id, name, ('berry_pat_' || public_id) AS prefix,
                                expires_at, last_used_at, revoked_at, created_at, scopes`;

const INVITATION_COLUMNS = `id, workspace_id, email, role::text AS role, invited_by,
                            expires_at, accepted_at, revoked_at, created_at`;

const MEMBER_COLUMNS = `m.workspace_id, m.user_id, m.role::text AS role,
                        u.email, u.name, u.avatar_url, m.joined_at, m.updated_at`;

/** The invitation token's fixed-length namespace. */
export const INVITATION_TOKEN_PREFIX = 'berry_inv_';

export interface PersonalToken {
   id: string;
   name: string;
   prefix: string;
   expiresAt: string | null;
   lastUsedAt: string | null;
   revokedAt: string | null;
   createdAt: string;
   scopes: string[] | null;
}

/**
 * An open invitation as the person it is addressed to sees it: which
 * workspace, at what role, and until when. No email and no token — they know
 * their own address, and the token is not theirs to be shown.
 */
export interface PendingInvitation {
   id: string;
   workspaceId: string;
   workspaceName: string;
   role: string;
   expiresAt: string;
   createdAt: string;
}

export interface Invitation {
   id: string;
   workspaceId: string;
   /**
    * The workspace's display name.
    *
    * Carried on the invitation because the person reading their own
    * invitations is not a member of the workspace yet, so they cannot look it
    * up — an id is not something anyone can decide about. Null only where the
    * row is built from a write that did not join it.
    */
   workspaceName: string | null;
   email: string;
   role: string;
   invitedBy: string;
   expiresAt: string;
   acceptedAt: string | null;
   revokedAt: string | null;
   createdAt: string;
}

export class SecretsRepository {
   private readonly sql: Sql;
   private readonly clock: () => Date;
   private readonly newId: () => string;
   private readonly random: (size: number) => Buffer;

   constructor(
      sql: Sql,
      clock: () => Date = () => new Date(),
      newId = () => crypto.randomUUID(),
      random: (size: number) => Buffer = randomBytes
   ) {
      this.sql = sql;
      this.clock = clock;
      this.newId = newId;
      this.random = random;
   }

   private now(): string {
      return this.clock().toISOString();
   }

   // ---- personal access tokens ------------------------------------------

   async listPersonalTokens(
      userId: string,
      after: TimeCursor | null,
      limit: number
   ): Promise<PersonalToken[]> {
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(PERSONAL_TOKEN_COLUMNS)}
           FROM personal_api_tokens
          WHERE user_id = ${userId}
            AND (NOT ${after !== null}::boolean OR
                (created_at, id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map(toPersonalToken);
   }

   /**
    * Issues one token, returning the secret exactly once.
    *
    * A replay returns the stored metadata with no secret: the caller either
    * kept what the first response gave them or they no longer have it, and
    * this cannot reconstruct it — only the digest was persisted.
    */
   async createPersonalToken(params: {
      userId: string;
      name: string;
      expiresAt: string | null;
      idempotencyKey: string;
      fingerprint: Buffer;
      scopes: ApiScope[] | null;
   }): Promise<{ token: PersonalToken; secret: string; replayed: boolean }> {
      const generated = generatePersonalToken(this.random);
      const keyHash = createHash('sha256').update(params.idempotencyKey).digest();
      const id = this.newId();

      return this.sql.begin(async (tx) => {
         const inserted = await tx`
            INSERT INTO personal_api_tokens (
               id, user_id, name, public_id, secret_hash,
               idempotency_key_hash, request_fingerprint, expires_at, scopes, created_at
            ) VALUES (
               ${id}, ${params.userId}, ${params.name}, ${generated.publicId},
               ${generated.secretHash}, ${keyHash}, ${params.fingerprint},
               ${params.expiresAt}, ${params.scopes === null ? null : tx.array(params.scopes)}, ${this.now()}
            )
            ON CONFLICT (user_id, idempotency_key_hash) DO NOTHING
            RETURNING ${tx.unsafe(PERSONAL_TOKEN_COLUMNS)}`.catch(classifyWrite);

         if (inserted.length > 0) {
            return { token: toPersonalToken(inserted[0]!), secret: generated.token, replayed: false };
         }

         const [existing] = await tx`
            SELECT ${tx.unsafe(PERSONAL_TOKEN_COLUMNS)}, request_fingerprint
              FROM personal_api_tokens
             WHERE user_id = ${params.userId} AND idempotency_key_hash = ${keyHash}`;
         if (!existing) throw new NotFound();
         if (!constantTimeEqual(existing.request_fingerprint as Buffer, params.fingerprint)) {
            throw new IdempotencyConflict();
         }
         return { token: toPersonalToken(existing), secret: '', replayed: true };
      });
   }

   /**
    * Revoking is idempotent, and silent about tokens that are not the
    * caller's: an unknown id and someone else's id are answered identically,
    * so this cannot be used to discover which ids exist.
    */
   async revokePersonalToken(userId: string, tokenId: string): Promise<void> {
      await this.sql`
         UPDATE personal_api_tokens
            SET revoked_at = COALESCE(revoked_at, ${this.now()})
          WHERE id = ${tokenId} AND user_id = ${userId}`;
   }

   // ---- invitations ------------------------------------------------------

   async listWorkspaceInvitations(
      userId: string,
      workspaceId: string,
      after: TimeCursor | null,
      limit: number
   ): Promise<Invitation[]> {
      await this.authorize(workspaceId, userId, 'invitations.read');
      const rows = await this.sql`
         SELECT ${this.sql.unsafe(INVITATION_COLUMNS)},
                (SELECT workspace.name FROM workspaces AS workspace
                  WHERE workspace.id = workspace_invitations.workspace_id) AS workspace_name
           FROM workspace_invitations
          WHERE workspace_id = ${workspaceId}
            AND (NOT ${after !== null}::boolean OR
                (created_at, id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map(toInvitation);
   }

   /** Only invitations still open, still addressed to this user, in a live workspace. */
   async listPersonalInvitations(
      userId: string,
      after: TimeCursor | null,
      limit: number
   ): Promise<Invitation[]> {
      const [user] = await this.sql`SELECT email FROM users WHERE id = ${userId}`;
      if (!user) throw new NotFound();
      const email = (user.email as string).toLowerCase();
      const now = this.now();

      const rows = await this.sql`
         SELECT ${this.sql.unsafe(INVITATION_COLUMNS)},
                (SELECT workspace.name FROM workspaces AS workspace
                  WHERE workspace.id = workspace_invitations.workspace_id) AS workspace_name
           FROM workspace_invitations
          WHERE email = ${email}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
            AND expires_at > ${now}
            AND EXISTS (
                SELECT 1 FROM workspaces AS workspace
                 WHERE workspace.id = workspace_invitations.workspace_id
                   AND workspace.deleted_at IS NULL
            )
            AND (NOT ${after !== null}::boolean OR
                (created_at, id) < (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}`;
      return rows.map(toInvitation);
   }

   /**
    * The same invitations, with the name of the workspace each one is for.
    *
    * A separate read from `listPersonalInvitations` rather than a wider one:
    * that list is a paged API resource with a stable shape, and this is what a
    * switcher needs to draw a row — "join Acme" rather than "join
    * 4f3c…". Neither carries the token, which is what makes `join` a
    * different act from `accept`.
    */
   async listPendingInvitations(userId: string, limit: number): Promise<PendingInvitation[]> {
      const [user] = await this.sql`SELECT email FROM users WHERE id = ${userId}`;
      if (!user) throw new NotFound();
      const email = (user.email as string).toLowerCase();
      const now = this.now();

      const rows = await this.sql`
         SELECT invitation.id, invitation.workspace_id, invitation.role::text AS role,
                invitation.expires_at, invitation.created_at,
                workspace.name AS workspace_name
           FROM workspace_invitations AS invitation
           JOIN workspaces AS workspace
             ON workspace.id = invitation.workspace_id AND workspace.deleted_at IS NULL
          WHERE invitation.email = ${email}
            AND invitation.accepted_at IS NULL
            AND invitation.revoked_at IS NULL
            AND invitation.expires_at > ${now}
          ORDER BY invitation.created_at DESC, invitation.id DESC
          LIMIT ${limit}`;
      return rows.map((row) => ({
         id: row.id as string,
         workspaceId: row.workspace_id as string,
         workspaceName: row.workspace_name as string,
         role: row.role as string,
         expiresAt: toRFC3339(row.expires_at as string) ?? '',
         createdAt: toRFC3339(row.created_at as string) ?? '',
      }));
   }

   /**
    * Accept an invitation the caller can already see, without a token.
    *
    * `acceptInvitation` answers a link: the token is the proof, because the
    * person following it may not be signed in as anybody in particular. This
    * answers a list: the session is the proof, and the predicate is exactly the
    * one that put the invitation in that list — still open, not lapsed, and
    * addressed to this account's own address. Anything else is a plain
    * not-found, so the route cannot be used to discover whose invitation an id
    * belongs to.
    */
   async joinInvitation(userId: string, invitationId: string): Promise<Membership> {
      const [user] = await this.sql`SELECT email FROM users WHERE id = ${userId}`;
      if (!user) throw new NotFound();
      const userEmail = (user.email as string).toLowerCase();
      const now = this.now();

      return this.sql.begin(async (tx) => {
         const [row] = await tx`
            SELECT invitation.workspace_id, invitation.email, invitation.role::text AS role,
                   invitation.expires_at, invitation.accepted_at, invitation.accepted_by,
                   invitation.revoked_at
              FROM workspace_invitations AS invitation
              JOIN workspaces AS workspace
                ON workspace.id = invitation.workspace_id AND workspace.deleted_at IS NULL
             WHERE invitation.id = ${invitationId}
             FOR UPDATE OF invitation`;
         if (
            !row ||
            row.email !== userEmail ||
            row.revoked_at !== null ||
            !(new Date(row.expires_at as string) > new Date(now))
         ) {
            throw new NotFound();
         }

         const workspaceId = row.workspace_id as string;
         if (row.accepted_at !== null) {
            // Already taken up. By this person it is simply their membership
            // again; by anyone else there is nothing here to see.
            if (row.accepted_by !== userId) throw new NotFound();
            return membershipIn(tx, workspaceId, userId);
         }

         await tx`
            INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
            VALUES (${workspaceId}, ${userId}, ${row.role as string}, ${now}, ${now})
            ON CONFLICT (workspace_id, user_id) DO NOTHING`.catch(classifyWrite);
         await tx`
            UPDATE workspace_invitations
               SET accepted_at = ${now}, accepted_by = ${userId}
             WHERE id = ${invitationId}`;
         // Joining is itself a completed onboarding, as it is on the token path.
         await tx`
            UPDATE users
               SET last_workspace_id = ${workspaceId},
                   onboarding_state =
                       '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
                   onboarding_completed_at = COALESCE(onboarding_completed_at, ${now}),
                   updated_at = ${now}
             WHERE id = ${userId}`;
         return membershipIn(tx, workspaceId, userId);
      });
   }

   /**
    * Turn one down. Withdrawn is withdrawn: the row is retired the same way a
    * revocation retires it, so the offer stops being listed here and cannot be
    * taken up later by following the emailed link either.
    */
   async declineInvitation(userId: string, invitationId: string): Promise<void> {
      const [user] = await this.sql`SELECT email FROM users WHERE id = ${userId}`;
      if (!user) throw new NotFound();
      const email = (user.email as string).toLowerCase();

      const rows = await this.sql`
         UPDATE workspace_invitations
            SET revoked_at = ${this.now()}
          WHERE id = ${invitationId}
            AND email = ${email}
            AND accepted_at IS NULL
            AND revoked_at IS NULL
          RETURNING id`;
      if (rows.length !== 1) throw new NotFound();
   }

   /**
    * Invites one address, subject to two separate rules.
    *
    * `invitations.write` is the ordinary permission, but a plain member may
    * also invite when the workspace has opted in — and only ever as member or
    * viewer. Separately, nobody invites an owner, and only an owner invites an
    * admin: otherwise an admin could grow the set of people who can remove
    * them.
    */
   async createInvitation(params: {
      actorId: string;
      workspaceId: string;
      email: string;
      role: string;
      expiresAt: string;
      idempotencyKey: string;
      fingerprint: Buffer;
   }): Promise<{ invitation: Invitation; token: string; replayed: boolean }> {
      const workspace = await this.workspaceFor(params.workspaceId, params.actorId);

      let permitted = allows(workspace.role, 'invitations.write');
      if (
         !permitted &&
         workspace.role === 'member' &&
         workspace.allowMemberInvites &&
         (params.role === 'member' || params.role === 'viewer')
      ) {
         permitted = true;
      }
      if (!permitted) throw new Forbidden();
      if (params.role === 'owner' || (workspace.role !== 'owner' && params.role === 'admin')) {
         throw new Forbidden();
      }

      const [member] = await this.sql`
         SELECT EXISTS (
            SELECT 1
              FROM workspace_memberships AS m
              JOIN users AS u ON u.id = m.user_id
             WHERE m.workspace_id = ${params.workspaceId} AND lower(u.email) = lower(${params.email})
         ) AS present`;
      if (member?.present) throw new Conflict();

      const token = INVITATION_TOKEN_PREFIX + generateToken(this.random);
      const tokenHash = createHash('sha256').update(token).digest();
      const keyHash = createHash('sha256').update(params.idempotencyKey).digest();
      const id = this.newId();
      const now = this.now();

      return this.sql.begin(async (tx) => {
         // A pending invitation that has already lapsed is retired first, so
         // the partial unique index does not block a fresh one.
         await tx`
            UPDATE workspace_invitations
               SET revoked_at = ${now}
             WHERE workspace_id = ${params.workspaceId}
               AND email = ${params.email}
               AND accepted_at IS NULL
               AND revoked_at IS NULL
               AND expires_at <= ${now}`;

         const inserted = await tx`
            INSERT INTO workspace_invitations (
               id, workspace_id, email, role, invited_by, token_hash,
               idempotency_key_hash, request_fingerprint, expires_at, created_at
            ) VALUES (
               ${id}, ${params.workspaceId}, ${params.email}, ${params.role}, ${params.actorId},
               ${tokenHash}, ${keyHash}, ${params.fingerprint}, ${params.expiresAt}, ${now}
            )
            ON CONFLICT (workspace_id, invited_by, idempotency_key_hash) DO NOTHING
            RETURNING ${tx.unsafe(INVITATION_COLUMNS)}`.catch(classifyWrite);

         if (inserted.length > 0) {
            return { invitation: toInvitation(inserted[0]!), token, replayed: false };
         }

         const [existing] = await tx`
            SELECT ${tx.unsafe(INVITATION_COLUMNS)}, request_fingerprint
              FROM workspace_invitations
             WHERE workspace_id = ${params.workspaceId}
               AND invited_by = ${params.actorId}
               AND idempotency_key_hash = ${keyHash}`;
         if (!existing) throw new NotFound();
         if (!constantTimeEqual(existing.request_fingerprint as Buffer, params.fingerprint)) {
            throw new IdempotencyConflict();
         }
         return { invitation: toInvitation(existing), token: '', replayed: true };
      });
   }

   async revokeInvitation(userId: string, workspaceId: string, invitationId: string): Promise<void> {
      await this.authorize(workspaceId, userId, 'invitations.write');
      const updated = await this.sql`
         UPDATE workspace_invitations
            SET revoked_at = COALESCE(revoked_at, ${this.now()})
          WHERE id = ${invitationId}
            AND workspace_id = ${workspaceId}
            AND accepted_at IS NULL`;
      if (updated.count !== 1) throw new NotFound();
   }

   /**
    * Accepts an invitation under a row lock, creating membership atomically.
    *
    * Every invalid state — wrong secret, wrong recipient, revoked, expired,
    * missing — returns the same error. A caller holding a token learns only
    * whether it worked, never why it did not, so this cannot be used to
    * enumerate invitations or confirm who was invited.
    */
   async acceptInvitation(
      userId: string,
      invitationId: string,
      token: string | null
   ): Promise<Membership> {
      // The token proves the invitation reached whoever holds the link, and it
      // is optional rather than required: an invitation addressed to *this
      // account* is proof enough on its own, because the address is checked
      // against the caller's own below either way. That is what lets someone
      // accept an invitation from their own list, which never held a token.
      // A token that is supplied must still be valid, so presenting a wrong
      // one is never a way in.
      //
      // Everything after the fixed-length prefix is the secret. No separator
      // check: base64url contains '_', and one here refused 48% of the tokens
      // this service issues.
      if (token !== null) {
         if (!token.startsWith(INVITATION_TOKEN_PREFIX)) throw new InvitationInvalid();
         const secret = token.slice(INVITATION_TOKEN_PREFIX.length);
         try {
            if (parseAuthorization(`Bearer ${secret}`) !== secret) throw new InvitationInvalid();
         } catch {
            throw new InvitationInvalid();
         }
      }

      const [user] = await this.sql`SELECT email FROM users WHERE id = ${userId}`;
      if (!user) throw new NotFound();
      const userEmail = (user.email as string).toLowerCase();
      const presented = token === null ? null : createHash('sha256').update(token).digest();
      const now = this.now();

      return this.sql.begin(async (tx) => {
         const [row] = await tx`
            SELECT workspace_id, email, role::text AS role, token_hash, expires_at,
                   accepted_at, accepted_by, revoked_at
              FROM workspace_invitations AS invitation
              JOIN workspaces AS workspace
                ON workspace.id = invitation.workspace_id AND workspace.deleted_at IS NULL
             WHERE invitation.id = ${invitationId}
             FOR UPDATE OF invitation`;
         if (!row) throw new InvitationInvalid();

         // Without a token the address is the whole proof, which is why the
         // email comparison below guards both paths rather than only this one.
         const validHash =
            presented === null || constantTimeEqual(row.token_hash as Buffer, presented);
         if (
            !validHash ||
            row.email !== userEmail ||
            row.revoked_at !== null ||
            !(new Date(row.expires_at as string) > new Date(now))
         ) {
            throw new InvitationInvalid();
         }

         const workspaceId = row.workspace_id as string;
         if (row.accepted_at !== null) {
            // Already accepted: a replay by the same person is their own
            // membership; by anyone else it is a stolen token.
            if (row.accepted_by !== userId) throw new InvitationInvalid();
            return membershipIn(tx, workspaceId, userId);
         }

         await tx`
            INSERT INTO workspace_memberships (workspace_id, user_id, role, joined_at, updated_at)
            VALUES (${workspaceId}, ${userId}, ${row.role as string}, ${now}, ${now})
            ON CONFLICT (workspace_id, user_id) DO NOTHING`.catch(classifyWrite);
         await tx`
            UPDATE workspace_invitations
               SET accepted_at = ${now}, accepted_by = ${userId}
             WHERE id = ${invitationId}`;
         // Joining by invitation is itself a completed onboarding: the invitee
         // lands in the workspace rather than in a setup flow.
         await tx`
            UPDATE users
               SET last_workspace_id = ${workspaceId},
                   onboarding_state =
                       '{"version":1,"step":"complete","answers":{},"skipped":false,"completed":true}'::jsonb,
                   onboarding_completed_at = COALESCE(onboarding_completed_at, ${now}),
                   updated_at = ${now}
             WHERE id = ${userId}`;
         return membershipIn(tx, workspaceId, userId);
      });
   }

   // ---- shared -----------------------------------------------------------

   private async authorize(
      workspaceId: string,
      userId: string,
      permission: Parameters<typeof allows>[1]
   ): Promise<string> {
      const [row] = await this.sql`
         SELECT m.role::text AS role
           FROM workspace_memberships AS m
           JOIN workspaces AS w ON w.id = m.workspace_id
          WHERE m.workspace_id = ${workspaceId}
            AND m.user_id = ${userId}
            AND w.deleted_at IS NULL`;
      if (!row) throw new NotFound();
      const role = row.role as string;
      if (!allows(role, permission)) throw new Forbidden();
      return role;
   }

   private async workspaceFor(
      workspaceId: string,
      userId: string
   ): Promise<{ role: string; allowMemberInvites: boolean }> {
      const [row] = await this.sql`
         SELECT m.role::text AS role, w.settings
           FROM workspace_memberships AS m
           JOIN workspaces AS w ON w.id = m.workspace_id
          WHERE w.id = ${workspaceId} AND m.user_id = ${userId} AND w.deleted_at IS NULL`;
      if (!row) throw new NotFound();
      const settings = (row.settings ?? {}) as { allowMemberInvites?: boolean };
      return { role: row.role as string, allowMemberInvites: settings.allowMemberInvites ?? false };
   }
}

async function membershipIn(tx: Queryable, workspaceId: string, userId: string): Promise<Membership> {
   const [row] = await tx`
      SELECT ${tx.unsafe(MEMBER_COLUMNS)}
        FROM workspace_memberships AS m
        JOIN users AS u ON u.id = m.user_id
       WHERE m.workspace_id = ${workspaceId} AND m.user_id = ${userId}`;
   if (!row) throw new NotFound();
   return {
      workspaceId: row.workspace_id as string,
      userId: row.user_id as string,
      role: row.role as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      joinedAt: toRFC3339(row.joined_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

function classifyWrite(error: unknown): never {
   if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
      throw new Conflict();
   }
   throw error;
}

function constantTimeEqual(left: Buffer | null, right: Buffer): boolean {
   if (!left || left.length !== right.length) return false;
   return timingSafeEqual(left, right);
}

function toPersonalToken(row: Record<string, unknown>): PersonalToken {
   return {
      id: row.id as string,
      name: row.name as string,
      prefix: row.prefix as string,
      expiresAt: optionalTime(row.expires_at),
      lastUsedAt: optionalTime(row.last_used_at),
      revokedAt: optionalTime(row.revoked_at),
      createdAt: toRFC3339(row.created_at as string) ?? '',
      scopes: (row.scopes as string[] | null) ?? null,
   };
}

function toInvitation(row: Record<string, unknown>): Invitation {
   return {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      workspaceName: (row.workspace_name as string | null) ?? null,
      email: row.email as string,
      role: row.role as string,
      invitedBy: row.invited_by as string,
      expiresAt: toRFC3339(row.expires_at as string) ?? '',
      acceptedAt: optionalTime(row.accepted_at),
      revokedAt: optionalTime(row.revoked_at),
      createdAt: toRFC3339(row.created_at as string) ?? '',
   };
}

function optionalTime(value: unknown): string | null {
   return value ? toRFC3339(value as string) : null;
}
