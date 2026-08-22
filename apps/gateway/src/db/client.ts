import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "~/config";
import * as schema from "~/db/schema";

/**
 * Shared request-time database handle.
 *
 * `src/db/migrate.ts` owns its own single-connection client for the migration
 * step; this module is the pooled handle used by request handlers. It is built
 * lazily on first use so that importing a route module (or running `bun test`
 * with no `DATABASE_URL`) never opens a connection — a request path that truly
 * needs the database fails fast here with a clear message instead.
 */

export type BerryDb = PostgresJsDatabase<typeof schema>;
export type Database = BerryDb;

/** Builds a database handle for an explicit connection string (used by tests
 * that connect to an ephemeral Postgres). */
export function createDb(databaseUrl: string, max = 10): BerryDb {
  return drizzle(postgres(databaseUrl, { max }), { schema });
}

let pool: ReturnType<typeof postgres> | undefined;
let db: BerryDb | undefined;

export function getDb(): BerryDb {
  if (!db) {
    if (!config.DATABASE_URL) {
      throw new Error("DATABASE_URL is not configured; this endpoint requires a database.");
    }
    pool = postgres(config.DATABASE_URL, { max: 10 });
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Closes the pool. Intended for graceful shutdown and test teardown. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
