import { withinTx, type Sql } from '../db/pool.ts';

/**
 * Empties a development workspace of its work, keeping the workspace.
 *
 * Projects, goals, tasks and runs go; users, workspaces, boards, agents and
 * integrations stay. What is removed is what a person made while trying
 * something out — what is kept is what they would have to set up again.
 *
 * Everything else follows by cascade: plans and their versions, the tasks a
 * plan compiled, comments, approvals, run events and artifacts. Naming them
 * here as well would only be a second list to keep in step with the schema.
 */

export interface ResetCounts {
   projects: number;
   goals: number;
   issues: number;
   runs: number;
   outboxEvents: number;
}

export class NotABerryDatabase extends Error {
   override readonly name = 'NotABerryDatabase';
}

/**
 * Refuses a database that is not Berry's.
 *
 * A destructive command pointed at the wrong server is the failure worth
 * spending a query on. `DATABASE_URL` is easy to inherit from a shell, a
 * second PostgreSQL is easy to have listening on the same port, and both
 * answer to the same database name — so what is checked is the schema, which
 * only Berry's migrations produce.
 */
export async function assertBerryDatabase(sql: Sql): Promise<void> {
   const [row] = await sql<Array<{ ledger: string | null; projects: string | null }>>`
      SELECT to_regclass('public.berry_schema_migrations')::text AS ledger,
             to_regclass('public.projects')::text AS projects`;
   if (!row?.ledger || !row.projects) {
      const [where] = await sql<Array<{ db: string; host: string | null }>>`
         SELECT current_database() AS db, inet_server_addr()::text AS host`;
      throw new NotABerryDatabase(
         `the database "${where?.db ?? '?'}" at ${where?.host ?? 'this server'} has no Berry ` +
            'schema — refusing to delete from it'
      );
   }
}

/**
 * Deletes the work, in one transaction.
 *
 * The outbox goes with it. It is the replay buffer the realtime stream serves
 * on reconnect, so events about rows that no longer exist would arrive at a
 * browser as tasks and runs it then has to be told again to forget.
 */
export async function apply(sql: Sql): Promise<ResetCounts> {
   await assertBerryDatabase(sql);

   return withinTx(sql, async (tx) => {
      /** How many rows a `RETURNING` statement removed. */
      const count = async (rows: PromiseLike<{ length: number }>): Promise<number> =>
         (await rows).length;

      // Goals before projects and issues before both: the cascades would run
      // either way, but this order is the one whose counts describe what was
      // actually there rather than what a cascade had already taken.
      const outboxEvents = await count(tx`DELETE FROM outbox_events RETURNING 1`);
      const runs = await count(tx`DELETE FROM runs RETURNING 1`);
      const goals = await count(tx`DELETE FROM goals RETURNING 1`);
      const issues = await count(tx`DELETE FROM issues RETURNING 1`);
      const projects = await count(tx`DELETE FROM projects RETURNING 1`);

      return { projects, goals, issues, runs, outboxEvents };
   });
}
