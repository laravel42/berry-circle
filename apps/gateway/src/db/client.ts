import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "~/config";
import * as schema from "~/db/schema";

/**
 * Shared drizzle handle for Berry-owned product state. `migrate.ts` opens its
 * own short-lived connection for the migration run; this is the long-lived
 * request-path pool the routes use.
 */
export type BerryDb = PostgresJsDatabase<typeof schema>;

/** Builds a database handle for an explicit connection string (used by tests
 * that connect to an ephemeral Postgres). */
export function createDb(databaseUrl: string, max = 10): BerryDb {
  return drizzle(postgres(databaseUrl, { max }), { schema });
}

let singleton: BerryDb | null | undefined;

/**
 * Process-wide database handle built lazily from `DATABASE_URL`, or `null` when
 * unset. Returning `null` (rather than throwing) keeps `createApp()` usable for
 * the health endpoint and unit tests with no database configured; storage-backed
 * routes translate a `null` handle into `503 DEPENDENCY_UNAVAILABLE`.
 */
export function getDb(): BerryDb | null {
  if (singleton === undefined) {
    singleton = config.DATABASE_URL ? createDb(config.DATABASE_URL) : null;
  }
  return singleton;
}
