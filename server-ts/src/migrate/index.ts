import { loadConfig } from '../config/config.ts';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { createLogger } from '../observability/log.ts';
import { apply } from './migrations.ts';

/**
 * The migrator.
 *
 * Run to completion before the server starts, so readiness never races schema
 * setup. It exits non-zero on any drift rather than migrating over it.
 */

const config = loadConfig();
const logger = createLogger(`${config.serviceName}-migrate`);
const sql = openDatabase({ url: config.databaseUrl });

try {
   await apply(sql, logger);
   logger.info('database migrations are current');
} catch (error) {
   logger.error('migration failed', { error: error instanceof Error ? error.message : String(error) });
   await closeDatabase(sql).catch(() => {});
   process.exit(1);
}

await closeDatabase(sql);
