import postgres from 'postgres';

/**
 * The database, ported from server/internal/database/database.go.
 *
 * Both servers run against one PostgreSQL and one set of migrations for the
 * length of the migration, so nothing here owns schema — `../server/migrations`
 * does, and the Go binary applies it. This is a connection and a transaction
 * helper, nothing more.
 */

export type Sql = postgres.Sql<{ timestamptz: string; timestamp: string }>;

/**
 * A PostgreSQL timestamptz as Go renders it: RFC 3339 with a `Z`, keeping
 * whatever precision the column holds.
 *
 * postgres.js hands back `2026-08-23 05:47:19.652293+00`; the wire wants
 * `2026-08-23T05:47:19.652293Z`. Converting textually rather than through Date
 * is what preserves the microseconds.
 */
export function toRFC3339(value: string | null | undefined): string | null {
   if (!value) return null;
   const normalised = value.replace(' ', 'T');
   const zoned = normalised.replace(/([+-]\d{2})(:?\d{2})?$/, 'Z');
   return zoned.endsWith('Z') ? zoned : normalised + 'Z';
}

export interface DatabaseOptions {
   url: string;
   /** Mirrors pgxpool's default ceiling closely enough for one API process. */
   max?: number;
   connectTimeoutSeconds?: number;
}

export function openDatabase(options: DatabaseOptions): Sql {
   return postgres(options.url, {
      max: options.max ?? 10,
      connect_timeout: options.connectTimeoutSeconds ?? 10,
      // Timestamps come back as strings, not Dates, and that is a contract
      // requirement rather than a preference. PostgreSQL stores microseconds
      // and Go renders every digit — `2026-08-23T05:47:19.652293Z`. A
      // JavaScript Date holds milliseconds, so parsing and re-serializing
      // would silently emit `...652Z` and quietly drop precision the frontend
      // and every stored timestamp already carry.
      types: {
         timestamptz: { to: 1184, from: [1184], serialize: String, parse: String },
         timestamp: { to: 1114, from: [1114], serialize: String, parse: String },
      },
      onnotice: () => {},
   });
}

/** The readiness probe behind `/ready`: can this process reach the database. */
export async function checkDatabase(sql: Sql): Promise<void> {
   await sql`SELECT 1`;
}

/**
 * Runs `work` inside one transaction, ported from `WithinTx[T]`.
 *
 * Returns the callback's value, rolls back on any throw, and hands the
 * callback the transaction rather than the pool so a query cannot accidentally
 * escape onto a different connection — the mistake `WithinTx` exists to make
 * impossible in Go.
 */
export async function withinTx<T>(sql: Sql, work: (tx: Sql) => Promise<T>): Promise<T> {
   return sql.begin(async (tx) => work(tx as unknown as Sql)) as Promise<T>;
}

export async function closeDatabase(sql: Sql): Promise<void> {
   await sql.end({ timeout: 5 });
}
