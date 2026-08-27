import { randomUUID } from 'node:crypto';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { generateToken, hashToken } from './tokens.ts';

/**
 * Opaque session lifecycle, ported from server/internal/auth/sessions.go.
 *
 * Only the SHA-256 hash of a token is ever persisted, so a database leak hands
 * an attacker nothing usable. The raw token exists once, in the login
 * response, and is never written down.
 */

export type Role = 'admin' | 'member' | 'viewer';

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

      const token = this.randomToken();
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.ttlMs);

      await this.sql`
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
