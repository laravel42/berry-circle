import postgres from 'postgres';

/**
 * The database, ported from server/internal/database/database.go.
 *
 * Both servers run against one PostgreSQL and one set of migrations for the
 * length of the migration, so nothing here owns schema — `../server/migrations`
 * does, and the Go binary applies it. This is a connection and a transaction
 * helper, nothing more.
 */

export type Sql = postgres.Sql<Record<string, never>>;

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
      // Berry stores timestamps as timestamptz and reads them back as ISO
      // strings on the wire; leaving parsing to the driver keeps Date objects
      // out of places that only ever serialize them.
      types: {},
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
