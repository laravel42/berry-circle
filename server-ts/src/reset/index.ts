import { loadConfig } from '../config/config.ts';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { createLogger } from '../observability/log.ts';
import { apply, assertBerryDatabase } from './reset.ts';

/**
 * Empties a development database of its work.
 *
 * Projects, goals, tasks and runs go, along with everything that hangs off
 * them; workspaces, users, boards, agents and integrations stay, so the next
 * `pnpm dev` starts on a clean board rather than on an empty install.
 *
 * It refuses to run without `--yes`, refuses a database that has no Berry
 * schema, and prints the database it is about to empty before it does — a
 * destructive command that guesses its target is worse than no command.
 */

/**
 * Whether the caller said yes, in any spelling that survives the trip.
 *
 * A bare word as well as a flag, because `pnpm run <script> --yes` does not
 * reach here: pnpm reads every flag after a script name as its own and exits
 * 9 before node starts. `pnpm reset:server yes` works, `-- --yes` works, and
 * `--yes` works when this file is run directly. A confirmation nobody can
 * type is the same as no command at all.
 */
const CONSENT = new Set(['--yes', '-y', 'yes', 'confirm']);
const confirmed = process.argv.slice(2).some((argument) => CONSENT.has(argument));

const config = loadConfig();
const logger = createLogger(`${config.serviceName}-reset`);
const sql = openDatabase({ url: config.databaseUrl });

try {
   const [target] = await sql<Array<{ db: string; user: string; server: string | null }>>`
      SELECT current_database() AS db,
             current_user AS user,
             coalesce(inet_server_addr()::text, 'local socket') AS server`;

   if (!confirmed) {
      logger.error('refusing to reset without confirmation', {
         run: 'pnpm reset:server yes',
         database: target?.db,
         server: target?.server,
         removes: 'projects, goals, tasks, runs and everything that hangs off them',
         keeps: 'workspaces, users, boards, agents, integrations',
      });
      await closeDatabase(sql);
      process.exit(1);
   }

   logger.info('resetting', { database: target?.db, server: target?.server, user: target?.user });

   // Before the first read, not just before the delete: reaching the wrong
   // server should say so, rather than fail later as a missing relation.
   await assertBerryDatabase(sql);

   // Repositories are untouched, and this is the one line worth being loud
   // about: they are GitHub's now, owned by the workspace's organization.
   // Deleting somebody's code because a development database was reset would
   // be unrecoverable, so the reset has no way to do it at all.
   const counts = await apply(sql);

   logger.info('reset complete', { ...counts });
} catch (error) {
   logger.error('reset failed', { error: error instanceof Error ? error.message : String(error) });
   await closeDatabase(sql).catch(() => {});
   process.exit(1);
}

await closeDatabase(sql);
