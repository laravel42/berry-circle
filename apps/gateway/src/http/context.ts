import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import type { Actor } from "~/api/actors";
import type { BerryDb } from "~/db/client";
import { users } from "~/db/schema";
import { dependencyUnavailable, unauthenticated } from "~/http/errors";

/** Narrows an optional database handle, or fails with `503` when storage is not
 * configured (no `DATABASE_URL`). */
export function requireDb(db: BerryDb | null): BerryDb {
  if (!db) {
    throw dependencyUnavailable("The database is not configured.");
  }
  return db;
}

const actorTypeSchema = z.enum(["user", "agent"]);
const uuidSchema = z.string().uuid();

/**
 * Resolves the acting identity for a mutating request.
 *
 * ⚠️ Release 1 seam: the actor is read from `X-Berry-Actor-Type` /
 * `X-Berry-Actor-Id` (+ optional `X-Berry-Actor-Admin`) headers. Session auth
 * (BERR-24) replaces this function's body with token → session → actor
 * resolution; every caller and the `401 UNAUTHENTICATED` contract stay the same.
 * A `user` actor must exist in the `users` table, mirroring "invalid or expired
 * session" → `401`.
 */
export async function requireActor(c: Context, db: BerryDb): Promise<Actor> {
  const type = actorTypeSchema.safeParse(c.req.header("X-Berry-Actor-Type"));
  const id = uuidSchema.safeParse(c.req.header("X-Berry-Actor-Id"));
  if (!type.success || !id.success) {
    throw unauthenticated();
  }

  if (type.data === "user") {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, id.data))
      .limit(1);
    if (!row) {
      throw unauthenticated("The session actor does not exist.");
    }
  }

  return {
    type: type.data,
    id: id.data,
    isAdmin: c.req.header("X-Berry-Actor-Admin") === "true",
  };
}
