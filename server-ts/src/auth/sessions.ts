import { randomUUID } from 'node:crypto';
import { toRFC3339, type Queryable, type Sql } from '../db/pool.ts';
import { ConfigError } from '../identity/errors.ts';
import { verifyPassword, type StoredPassword } from './password.ts';
import {
   generateToken,
   hashToken,
   isPersonalToken,
   parsePersonalToken,
   secretMatches,
} from './tokens.ts';

/**
 * Opaque session lifecycle.
 *
 * Only the SHA-256 hash of a token is ever persisted, so a database leak hands
 * an attacker nothing usable. The raw token exists once, in the login
 * response, and is never written down.
 */

export type Role = 'admin' | 'member' | 'viewer';

/**
 * Accepted session TTL window, in milliseconds: 300 s (5 min) to 2,592,000 s
 * (30 days) inclusive. A configured TTL outside this range is a
 * misconfiguration and is refused at issue time so no token is ever minted
 * against a bad lifetime (Requirements 3.1, 3.2).
 */
const MIN_TTL_MS = 300_000;
const MAX_TTL_MS = 2_592_000_000;

/** A user as every authenticated surface sees them. */
export interface User {
   id: string;
   email: string;
   name: string;
   avatarUrl: string | null;
   role: Role;
   currentWorkspaceId: string | null;
   createdAt: string;
   updatedAt: string;
}

export interface IssuedSession {
   token: string;
   expiresAt: string;
   user: User;
}

/** Non-authoritative audit context captured at login. */
export interface SessionMetadata {
   userAgent?: string | null;
   ip?: string | null;
}

export class InvalidCredentials extends Error {
   constructor() {
      super('invalid credentials');
      this.name = 'InvalidCredentials';
   }
}

export class SessionUnauthenticated extends Error {
   constructor() {
      super('unauthenticated');
      this.name = 'SessionUnauthenticated';
   }
}

export interface SessionServiceOptions {
   sql: Sql;
   sessionTtlMs: number;
   now?: () => Date;
   newId?: () => string;
   randomToken?: () => string;
}

export class SessionService {
   private readonly sql: Sql;
   private readonly ttlMs: number;
   private readonly now: () => Date;
   private readonly newId: () => string;
   private readonly randomToken: () => string;

   constructor(options: SessionServiceOptions) {
      if (options.sessionTtlMs <= 0) throw new Error('session TTL must be positive');
      this.sql = options.sql;
      this.ttlMs = options.sessionTtlMs;
      this.now = options.now ?? (() => new Date());
      this.newId = options.newId ?? randomUUID;
      this.randomToken = options.randomToken ?? generateToken;
   }

   /** Issues a session for an existing, case-insensitively matched email. */
   async issueKnownEmail(email: string, metadata: SessionMetadata = {}): Promise<IssuedSession> {
      const [row] = await this.sql`
         SELECT id, email, name, avatar_url, role::text AS role, last_workspace_id,
                created_at, updated_at
           FROM users
          WHERE lower(email) = lower(${email})
          LIMIT 1`;
      if (!row) throw new InvalidCredentials();

      return this.issueForRow(row, metadata);
   }

   /**
    * Verifies a password against the stored user, then issues via the shared
    * path.
    *
    * The user is loaded with its stored credential and `verifyPassword` always
    * runs a scrypt derivation — including a dummy one when no user or no
    * credential is found — so "unknown email" and "wrong password" take the
    * same code path, and both surface as {@link InvalidCredentials}
    * (Requirements 1.1–1.4).
    */
   async issuePassword(
      email: string,
      password: string,
      metadata: SessionMetadata = {}
   ): Promise<IssuedSession> {
      const [row] = await this.sql`
         SELECT id, email, name, avatar_url, role::text AS role, last_workspace_id,
                created_at, updated_at, password_hash, password_salt
           FROM users
          WHERE lower(email) = lower(${email})
          LIMIT 1`;

      const stored = toStoredPassword(row);
      const ok = await verifyPassword(password, stored);
      if (!row || !ok) throw new InvalidCredentials();

      return this.issueForRow(row, metadata);
   }

   /**
    * Issues a session for a user id, used by sign-up so the freshly created
    * user is handed a session through the same issuance path as password and
    * passwordless login (Requirement 11.3). Meant to run inside the sign-up
    * transaction that created the user, so `executor` defaults to the pool but
    * accepts the open transaction: the user row is created and the session is
    * issued atomically, and a failure on either side rolls both back.
    */
   async issueForUser(
      userId: string,
      metadata: SessionMetadata = {},
      executor: Queryable = this.sql
   ): Promise<IssuedSession> {
      const [row] = await executor`
         SELECT id, email, name, avatar_url, role::text AS role, last_workspace_id,
                created_at, updated_at
           FROM users
          WHERE id = ${userId}
          LIMIT 1`;
      if (!row) throw new InvalidCredentials();

      return this.issueForRow(row, metadata, executor);
   }

   /**
    * The one issuance path: generate a 256-bit token, persist only its SHA-256
    * hash with a TTL-bounded expiry, and hand back the raw token once. Every
    * public issue method funnels through here so passwordless, password, and
    * sign-up issuance are byte-for-byte the same mechanism (Requirement 11.3).
    */
   private async issueForRow(
      row: Record<string, unknown>,
      metadata: SessionMetadata,
      executor: Queryable = this.sql
   ): Promise<IssuedSession> {
      // Bounds are checked here, before any token is generated or persisted,
      // so every issue method (passwordless, password, sign-up) is covered by
      // one guard and an out-of-range TTL issues nothing.
      if (this.ttlMs < MIN_TTL_MS || this.ttlMs > MAX_TTL_MS) {
         throw new ConfigError(
            `session TTL must be within 300..2,592,000 seconds, got ${this.ttlMs} ms`
         );
      }

      const token = this.randomToken();
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.ttlMs);

      await executor`
         INSERT INTO sessions (
            id, user_id, token_hash, user_agent, ip, expires_at, created_at
         ) VALUES (
            ${this.newId()}, ${row.id as string}, ${hashToken(token)},
            ${metadata.userAgent ?? null}, ${metadata.ip ?? null},
            ${expiresAt.toISOString()}, ${now.toISOString()}
         )`;

      return { token, expiresAt: expiresAt.toISOString(), user: toUser(row) };
   }

   /**
    * Hashes the presented token and lets storage enforce expiry.
    *
    * The read is a write: it stamps `last_used_at` in the same statement that
    * checks the session is live, so a token cannot be resolved without the
    * ledger recording that it was — and there is no window between the two.
    */
   async resolveSession(token: string): Promise<User> {
      const now = this.now().toISOString();
      const [row] = await this.sql`
         WITH live_session AS (
            UPDATE sessions
               SET last_used_at = ${now}
             WHERE token_hash = ${hashToken(token)}
               AND expires_at > ${now}
               AND revoked_at IS NULL
             RETURNING user_id
         )
         SELECT u.id, u.email, u.name, u.avatar_url, u.role::text AS role,
                u.last_workspace_id, u.created_at, u.updated_at
           FROM live_session AS s
           JOIN users AS u ON u.id = s.user_id
          LIMIT 1`;
      if (!row) throw new SessionUnauthenticated();
      return toUser(row);
   }

   /**
    * Resolves any credential, dispatching on the reserved prefix.
    *
    * A token claiming the personal namespace is verified as one and never
    * falls back to session lookup, so a malformed PAT cannot be tried a second
    * time as a session token. Ported from auth.CompositeResolver.
    */
   async resolveCredential(token: string): Promise<User> {
      return isPersonalToken(token)
         ? this.resolvePersonalToken(token)
         : this.resolveSession(token);
   }

   /**
    * One indexed lookup on the public half, then a constant-time comparison of
    * the secret's digest.
    *
    * The public identifier is what makes this a single query: without it the
    * server would have to hash the presented secret against every stored row.
    * The stored side is a digest, so a database copy does not yield a usable
    * credential.
    */
   async resolvePersonalToken(token: string): Promise<User> {
      let parsed: { publicId: string; secret: string };
      try {
         parsed = parsePersonalToken(token);
      } catch {
         throw new SessionUnauthenticated();
      }

      const now = this.now().toISOString();
      const [row] = await this.sql`
         SELECT t.id, t.secret_hash, t.expires_at, t.revoked_at,
                u.id AS user_id, u.email, u.name, u.avatar_url, u.role::text AS role,
                u.last_workspace_id, u.created_at, u.updated_at
           FROM personal_api_tokens AS t
           JOIN users AS u ON u.id = t.user_id
          WHERE t.public_id = ${parsed.publicId}`;
      if (!row) throw new SessionUnauthenticated();

      const expiresAt = row.expires_at as string | null;
      if (row.revoked_at !== null || (expiresAt !== null && new Date(expiresAt) <= new Date(now))) {
         throw new SessionUnauthenticated();
      }
      if (!secretMatches(parsed.secret, row.secret_hash as Buffer)) {
         throw new SessionUnauthenticated();
      }

      // GREATEST, so a delayed request cannot move last_used_at backwards.
      const touched = await this.sql`
         UPDATE personal_api_tokens
            SET last_used_at = GREATEST(COALESCE(last_used_at, ${now}), ${now})
          WHERE id = ${row.id as string} AND revoked_at IS NULL`;
      if (touched.count !== 1) throw new SessionUnauthenticated();

      return toUser({ ...row, id: row.user_id });
   }

   /**
    * Revokes a session. An unknown token is a successful no-op — telling a
    * caller their token was not found is telling them something about tokens.
    */
   async revokeSession(token: string): Promise<void> {
      await this.sql`
         UPDATE sessions
            SET revoked_at = COALESCE(revoked_at, now())
          WHERE token_hash = ${hashToken(token)}`;
   }
}

/**
 * Reads a user row's stored password credential, or `null` when the user is
 * absent or holds no credential. Returning `null` (rather than throwing) lets
 * `issuePassword` route the no-user and no-credential cases through the same
 * always-derive `verifyPassword` path as a wrong password, so timing does not
 * reveal which addresses are registered (Requirement 1.4).
 */
function toStoredPassword(row: Record<string, unknown> | undefined): StoredPassword | null {
   if (!row) return null;
   const hash = row.password_hash as Buffer | null;
   const salt = row.password_salt as Buffer | null;
   if (!hash || !salt) return null;
   return { hash, salt };
}

function toUser(row: Record<string, unknown>): User {
   return {
      id: row.id as string,
      email: row.email as string,
      name: row.name as string,
      avatarUrl: (row.avatar_url as string | null) ?? null,
      role: row.role as Role,
      currentWorkspaceId: (row.last_workspace_id as string | null) ?? null,
      createdAt: toRFC3339(row.created_at as string) ?? '',
      updatedAt: toRFC3339(row.updated_at as string) ?? '',
   };
}

/**
 * The user shape on the wire.
 *
 * Built key by key in Go's field order, and deliberately without
 * `currentWorkspaceId` — the Go serializer does not emit it, and adding a
 * field to a response is as much a contract change as removing one.
 */
export function serializeUser(user: User): Record<string, unknown> {
   return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
   };
}
