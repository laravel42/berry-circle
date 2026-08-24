import type { BerryDb } from "~/db/client";
import { dependencyUnavailable } from "~/http/errors";

/** Narrows an optional database handle, or fails with `503` when storage is not
 * configured (no `DATABASE_URL`). */
export function requireDb(db: BerryDb | null): BerryDb {
  if (!db) {
    throw dependencyUnavailable("The database is not configured.");
  }
  return db;
}
