import { loadConfig } from '../config/config.ts';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { createLogger } from '../observability/log.ts';
import { BoardSlug, UserEmail, WorkspaceSlug } from './ids.ts';
import { apply } from './seed.ts';

/** The development seeder. */

const config = loadConfig();
const logger = createLogger(`${config.serviceName}-seed`);
const sql = openDatabase({ url: config.databaseUrl });

try {
   await apply(sql);
   logger.info('development seed data is current', {
      userEmail: UserEmail,
      workspaceSlug: WorkspaceSlug,
      boardSlug: BoardSlug,
   });
} catch (error) {
   logger.error('seed failed', { error: error instanceof Error ? error.message : String(error) });
   await closeDatabase(sql).catch(() => {});
   process.exit(1);
}

await closeDatabase(sql);
