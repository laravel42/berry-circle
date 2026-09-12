import { ModelCatalog } from '../agents/catalog.ts';
import { loadConfig } from '../config/config.ts';
import { closeDatabase, openDatabase } from '../db/pool.ts';
import { createLogger } from '../observability/log.ts';
import { applyFleet, chooseFleet, FLEET_SIZE } from './fleet.ts';

/**
 * Seeds a fleet of agents, one per model, so several models can be put to the
 * same task and compared.
 *
 * Separate from the development seed: it costs a Bedrock listing, it is not
 * wanted on every boot, and nobody should find twelve agents they did not ask
 * for. Pass a workspace slug to seed one; with none it tops up every
 * workspace.
 */

const config = loadConfig();
const logger = createLogger(`${config.serviceName}-seed-agents`);

if (!config.agents) {
   logger.error('no Bedrock credentials, so the model catalogue cannot be read');
   process.exit(1);
}

const sql = openDatabase({ url: config.databaseUrl });
const slug = process.argv[2]?.trim();

try {
   const catalog = new ModelCatalog({
      region: config.agents.region,
      ...(config.agents.credentials ? { credentials: config.agents.credentials } : {}),
   });
   const models = chooseFleet(await catalog.list(), FLEET_SIZE);
   if (models.length === 0) {
      logger.error('the catalogue named no model that supports tools');
      await closeDatabase(sql).catch(() => {});
      process.exit(1);
   }
   if (models.length < FLEET_SIZE) {
      logger.info('fewer models than a full fleet', { wanted: FLEET_SIZE, found: models.length });
   }

   const reports = await applyFleet(sql, models, slug ? { workspaceSlug: slug } : {});
   if (reports.length === 0) {
      logger.error('no such workspace', { workspaceSlug: slug ?? '(all)' });
      await closeDatabase(sql).catch(() => {});
      process.exit(1);
   }
   for (const report of reports) {
      logger.info('agent fleet is current', {
         workspaceSlug: report.workspaceSlug,
         created: report.created.length,
         alreadyThere: report.present.length,
         models: models.map((model) => model.id),
         ...(report.runtimeMissing
            ? { runtime: 'this workspace has no default runtime; its agents fall back to the deployment one' }
            : {}),
      });
   }
} catch (error) {
   logger.error('seeding the agent fleet failed', {
      error: error instanceof Error ? error.message : String(error),
   });
   await closeDatabase(sql).catch(() => {});
   process.exit(1);
}

await closeDatabase(sql);
