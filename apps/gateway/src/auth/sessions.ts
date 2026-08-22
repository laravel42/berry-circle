import { and, eq, gt, lt, sql } from "drizzle-orm";
import { generateSessionToken, hashToken } from "~/auth/tokens";
import type { AuthUser } from "~/auth/types";
import { config } from "~/config";
import { getDb } from "~/db/client";
import { sessions, users } from "~/db/schema";

/**
 * Server-side session lifecycle against the `sessions`/`users` tables.
 *
 * Sessions are opaque bearer tokens: created at login, verified on every
 * guarded request, and revoked at logout. Only token *hashes* touch the
 * database (see `src/auth/tokens.ts`).
 */

/** The user columns that make up an `AuthUser`; selected on every lookup. */
const authUserColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  avatarUrl: users.avatarUrl,
  role: users.role,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

export type SessionMeta = {
  userAgent?: string | null;
  ip?: string | null;
};

export type IssuedSession = {
  token: string;
  expiresAt: Date;
};

/** Looks up a user by case-insensitive email. Returns null when absent. */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const db = getDb();
  const rows = await db
    .select(authUserColumns)
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Creates a session for a user and returns the raw token (shown once) plus its
 * expiry. The token itself is never stored — only its hash.
 */
export async function createSession(
  userId: string,
  meta: SessionMeta = {},
): Promise<IssuedSession> {
  const db = getDb();
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    userAgent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Resolves a raw bearer token to its user, or null when the token is unknown
 * or its session has expired. Expiry is enforced in the query (`expires_at >
 * now()`), so an expired token never authenticates. Note expired rows are not
 * deleted here — they linger until `logout` or a `deleteExpiredSessions()`
 * sweep runs.
 */
export async function resolveSession(token: string): Promise<AuthUser | null> {
  const db = getDb();
  const rows = await db
    .select(authUserColumns)
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return rows[0] ?? null;
}

/** Revokes a session by deleting its row. Idempotent — unknown tokens no-op. */
export async function revokeSession(token: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/**
 * Deletes all sessions whose expiry has passed and returns the number removed.
 * Expiry is already enforced at resolve time, so this is pure housekeeping to
 * keep the `sessions` table from growing without bound; it is index-backed by
 * `sessions_expires_at_idx`. Intended to be driven by a scheduled job (a
 * periodic sweeper is a tracked follow-up, not wired up in this issue).
 */
export async function deleteExpiredSessions(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}
