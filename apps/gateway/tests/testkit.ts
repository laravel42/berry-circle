import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { CommentResource, IssueResource } from "~/api/dto";
import { createApp } from "~/app";
import { generateSessionToken, hashToken } from "~/auth/tokens";
import * as schema from "~/db/schema";
import { type UserRole, boards, sessions, users } from "~/db/schema";
import type { ErrorEnvelope } from "~/http/errors";
import type { Connection } from "~/http/pagination";
import type { Board } from "~/schemas/board";

export type { Board, CommentResource, IssueResource };
export type BoardConnection = Connection<Board>;
export type IssueConnection = Connection<IssueResource>;
export type CommentConnection = Connection<CommentResource>;
export type { ErrorEnvelope };

/** Reads a JSON response body as the expected shape (`res.json()` is `unknown`
 * under strict mode; the repo convention is to cast at the call site). */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Rewrites the key tuple of a real (server-issued) cursor while preserving its
 * scope fingerprint — the way a client could reconstruct a valid scope but
 * present a corrupt key. Used to prove the endpoints reject that with 400, not
 * 500.
 */
export function tamperCursorKey(cursor: string, key: unknown): string {
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  payload.k = key;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Shared harness for the route/integration tests. Each suite gets its own
 * connection and a `createApp` wired to it, plus seed helpers that track what
 * they create so `cleanup()` can drop it (issues/comments cascade from boards;
 * sessions cascade from users). Requires a migrated Postgres via `DATABASE_URL`;
 * suites skip otherwise, so `bun test` stays green on a fresh checkout —
 * mirroring the schema tests.
 *
 * Product routes authenticate via `requireAuth` → `resolveSession` → `getDb()`,
 * which is a separate pool on the same `DATABASE_URL`. Sessions are inserted
 * here (hash-only, no passwordless login) so route tests stay independent of
 * `AUTH_ALLOW_PASSWORDLESS_LOGIN`.
 */
export const DATABASE_URL = process.env.DATABASE_URL;

/** `Authorization: Bearer` (+ JSON content type) for `app.request` helpers. */
export function bearerHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

export function makeTestContext() {
  const client = postgres(DATABASE_URL ?? "", { max: 1 });
  const db = drizzle(client, { schema });
  const app = createApp({ db });
  const boardIds: string[] = [];
  const userIds: string[] = [];

  return {
    db,
    app,

    async seedBoard() {
      const slug = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const [board] = await db.insert(boards).values({ name: "Test board", slug }).returning();
      boardIds.push(board.id);
      return board;
    },

    rememberBoard(id: string) {
      boardIds.push(id);
    },

    async seedUser(name = "Tester", role: UserRole = "member") {
      const [user] = await db
        .insert(users)
        .values({ email: `${crypto.randomUUID()}@berry.test`, name, role })
        .returning();
      userIds.push(user.id);
      return user;
    },

    /**
     * Inserts a user and a hashed session row, returning the raw token so tests
     * can send `Authorization: Bearer`. Does not go through passwordless login.
     */
    async seedSession(name = "Tester", role: UserRole = "member") {
      const user = await this.seedUser(name, role);
      const token = generateSessionToken();
      await db.insert(sessions).values({
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      return { user, token, headers: bearerHeaders(token) };
    },

    async cleanup() {
      if (boardIds.length > 0) await db.delete(boards).where(inArray(boards.id, boardIds));
      if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
      await client.end();
    },
  };
}
