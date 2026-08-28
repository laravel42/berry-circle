import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from '../db/pool.ts';

/**
 * Forward-only schema migration.
 *
 * The ledger table, its checksums and the advisory lock key are the ones Berry
 * has always used, so a database migrated before this runner existed is
 * already current: it reads the same `berry_schema_migrations` rows and finds
 * nothing to do. That compatibility is the point — changing the runner must
 * not ask anyone to reset a database.
 */

/** `BerryMig` as a big-endian int64 — the key Berry has always locked on. */
const ADVISORY_LOCK_KEY = '4784356015137974631';

const MIGRATION_NAME = /^([0-9]{3})_[a-z0-9_]+\.up\.sql$/;

/** `server-ts/migrations`, resolved from this module rather than the cwd. */
const DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** One immutable, forward-only database change. */
export interface Migration {
   version: number;
   name: string;
   sql: string;
   /** SHA-256 of the file's bytes, hex — what the ledger stores. */
   checksum: string;
}

export interface Logger {
   info(message: string, fields?: Record<string, unknown>): void;
   error(message: string, fields?: Record<string, unknown>): void;
}

/** The validated migrations in ascending version order. */
export async function list(directory: string = DIRECTORY): Promise<Migration[]> {
   const names = (await readdir(directory)).filter((name) => name.endsWith('.up.sql')).sort();

   const migrations: Migration[] = [];
   const versions = new Map<number, string>();
   for (const name of names) {
      const match = MIGRATION_NAME.exec(name);
      if (!match) throw new Error(`invalid migration filename ${JSON.stringify(name)}`);

      const version = Number(match[1]);
      const previous = versions.get(version);
      if (previous !== undefined) {
         throw new Error(
            `duplicate migration version ${match[1]} in ${JSON.stringify(previous)} and ${JSON.stringify(name)}`
         );
      }
      versions.set(version, name);

      // Hashed as bytes, not as a decoded string: the checksum has to match
      // the one already recorded for the file, and a re-encode could differ.
      const body = await readFile(path.join(directory, name));
      migrations.push({
         version,
         name,
         sql: body.toString('utf8'),
         checksum: createHash('sha256').update(body).digest('hex'),
      });
   }
   return migrations;
}

interface AppliedMigration {
   name: string;
   checksum: string;
}

/**
 * Applies every pending migration while holding a session advisory lock.
 *
 * The lock is what makes two processes starting at once safe — the second
 * blocks rather than racing the first through the same CREATE TABLE. It is
 * taken on a reserved connection because a pool would hand the unlock to a
 * different one, which PostgreSQL treats as not holding the lock at all.
 */
export async function apply(sql: Sql, logger: Logger): Promise<void> {
   const all = await list();

   const conn = await sql.reserve();
   try {
      await conn.unsafe(`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
      try {
         await conn.unsafe(`
            CREATE TABLE IF NOT EXISTS berry_schema_migrations (
               version integer PRIMARY KEY,
               name text NOT NULL UNIQUE,
               checksum char(64) NOT NULL,
               applied_at timestamptz NOT NULL DEFAULT now(),
               duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0)
            )
         `);

         const applied = await readApplied(conn);
         const expected = new Map(all.map((migration) => [migration.version, migration]));

         // Drift is fatal rather than repaired. A ledger row this runner
         // cannot account for means the database was migrated by something
         // else, and applying more on top of it would compound the divergence.
         for (const [version, record] of applied) {
            const padded = String(version).padStart(3, '0');
            const migration = expected.get(version);
            if (!migration) {
               throw new Error(
                  `migration ledger contains version ${padded} (${record.name}) missing from this build`
               );
            }
            if (record.name !== migration.name) {
               throw new Error(
                  `migration ${padded} name drift: ledger has ${JSON.stringify(record.name)}, build has ${JSON.stringify(migration.name)}`
               );
            }
            if (record.checksum !== migration.checksum) {
               throw new Error(`migration ${JSON.stringify(migration.name)} checksum drift`);
            }
         }

         for (const migration of all) {
            if (applied.has(migration.version)) continue;
            await applyOne(conn, migration, logger);
         }
      } finally {
         // Best effort: the lock dies with the session anyway, so a failure
         // here is worth reporting but must not mask the original error.
         await conn
            .unsafe(`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`)
            .catch((error: unknown) => logger.error('release migration lock', { error: String(error) }));
      }
   } finally {
      await conn.release();
   }
}

async function readApplied(conn: Sql): Promise<Map<number, AppliedMigration>> {
   const rows = await conn<{ version: number; name: string; checksum: string }[]>`
      SELECT version, name, checksum FROM berry_schema_migrations ORDER BY version
   `;
   return new Map(rows.map((row) => [row.version, { name: row.name, checksum: row.checksum }]));
}

/**
 * Runs one migration and records it, in a single transaction.
 *
 * The transaction is driven with explicit statements rather than `sql.begin`,
 * because a connection from `reserve()` does not have it: postgres.js builds
 * the reserved handle from the bare query tag, so `.begin` is absent at
 * runtime even though the typings declare `ReservedSql extends Sql`. Calling it
 * fails with `conn.begin is not a function` on the first migration.
 *
 * It has to be this connection either way — the advisory lock is session-scoped
 * and held here, so migrating on a pooled connection would apply the schema
 * outside the lock that is supposed to be protecting it.
 */
async function applyOne(conn: Sql, migration: Migration, logger: Logger): Promise<void> {
   const started = Date.now();
   await conn.unsafe('BEGIN');
   try {
      // `.simple()` is required: a migration is many statements in one file,
      // and the extended protocol accepts only one per round trip.
      await conn.unsafe(migration.sql).simple();
      const durationMs = Date.now() - started;
      await conn`
         INSERT INTO berry_schema_migrations (version, name, checksum, duration_ms)
         VALUES (${migration.version}, ${migration.name}, ${migration.checksum}, ${durationMs})
      `;
      await conn.unsafe('COMMIT');
   } catch (error) {
      // The connection is in a failed transaction and would reject everything
      // that followed, including the unlock, so this rollback matters even
      // though the process is about to exit.
      await conn.unsafe('ROLLBACK').catch(() => {});
      throw error;
   }
   logger.info('applied database migration', {
      name: migration.name,
      durationMs: Date.now() - started,
   });
}
