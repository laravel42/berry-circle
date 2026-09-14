import type { CatalogModel } from '../agents/catalog.ts';
import type { Sql } from '../db/pool.ts';

/**
 * A fleet of agents, one per model, for comparing models on the same work.
 *
 * The models are chosen when the seeder runs rather than written down here.
 * Which models an account may invoke differs by account and region, and a
 * hardcoded list would seed agents that cannot run the first time somebody
 * else uses it.
 */

/** How many agents a full fleet has. */
export const FLEET_SIZE = 12;

/**
 * The vendor's model line: `anthropic.claude`, `amazon.nova`, `meta.llama`.
 *
 * Cross-region profiles carry a region prefix (`us.`, `eu.`, `apac.`,
 * `global.`) that says nothing about the model, so it is dropped. Taking the
 * vendor alone would call Nova and Titan one family; taking the whole id would
 * make every version its own. The line in between is what a person means when
 * they say "a Claude" or "a Nova".
 */
export function modelFamily(id: string): string {
   const withoutRegion = id.replace(/^(us|eu|apac|global)\./, '');
   const [vendor = '', rest = ''] = withoutRegion.split('.', 2);
   const line = (rest.split(/[-:]/)[0] ?? '').trim();
   return line ? `${vendor}.${line}` : vendor;
}

/**
 * What this model costs, near enough to order by: one token in, one out.
 *
 * The catalogue reports a model it has no price for as zero, so a plain sum
 * would call every unpriced model free and put it at the front of a list that
 * claims to be the cheapest. Unknown sorts last instead.
 */
function price(model: CatalogModel): number {
   const total = model.inputCostPerM + model.outputCostPerM;
   return total > 0 ? total : Number.POSITIVE_INFINITY;
}

/**
 * The cheapest model of each family, then the next cheapest of any family
 * until the fleet is full.
 *
 * Breadth first: twelve Claude versions would compare a model against itself.
 * Only models that support tools are eligible, because a Berry agent that
 * cannot call a tool cannot do the work; a model with no published price sorts
 * last rather than being dropped, since an unpriced model is still a model —
 * it just cannot claim to be cheap.
 */
export function chooseFleet(models: CatalogModel[], size: number = FLEET_SIZE): CatalogModel[] {
   const eligible = models
      .filter((model) => model.supportsTools)
      .sort((left, right) => price(left) - price(right) || left.id.localeCompare(right.id));

   const chosen: CatalogModel[] = [];
   const families = new Set<string>();
   for (const model of eligible) {
      const family = modelFamily(model.id);
      if (families.has(family)) continue;
      families.add(family);
      chosen.push(model);
      if (chosen.length === size) return chosen;
   }
   for (const model of eligible) {
      if (chosen.includes(model)) continue;
      chosen.push(model);
      if (chosen.length === size) break;
   }
   return chosen;
}

/** `us.anthropic.claude-haiku-4-5-20251001-v1:0` -> `claude-haiku-4-5`. */
export function agentName(model: CatalogModel): string {
   const base = model.displayName.trim() || model.id;
   return base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
}

export interface FleetReport {
   workspaceSlug: string;
   created: string[];
   present: string[];
   /** Set when the workspace has no default runtime; its agents fall back to one. */
   runtimeMissing: boolean;
}

/**
 * Gives every workspace an agent per model, and binds each to the workspace's
 * default runtime.
 *
 * Idempotent by workspace and agent name: a second run reports what is already
 * there and creates the rest. An agent someone renamed or re-pointed is left
 * alone — this seeds a fleet, it does not enforce one.
 */
export async function applyFleet(
   sql: Sql,
   models: CatalogModel[],
   options: { workspaceSlug?: string } = {}
): Promise<FleetReport[]> {
   const workspaces = options.workspaceSlug
      ? await sql`SELECT id, slug FROM workspaces WHERE slug = ${options.workspaceSlug}`
      : await sql`SELECT id, slug FROM workspaces ORDER BY created_at`;

   const reports: FleetReport[] = [];
   for (const workspace of workspaces) {
      const workspaceId = workspace.id as string;
      const [runtime] = await sql`
         SELECT id FROM agent_runtimes
          WHERE workspace_id = ${workspaceId} AND is_default AND status = 'active'
          LIMIT 1`;
      const runtimeId = (runtime?.id as string | undefined) ?? null;

      const report: FleetReport = {
         workspaceSlug: workspace.slug as string,
         created: [],
         present: [],
         runtimeMissing: runtimeId === null,
      };

      for (const model of models) {
         const name = agentName(model);
         const [existing] = await sql`
            SELECT id FROM agents
             WHERE workspace_id = ${workspaceId} AND name = ${name} AND archived_at IS NULL`;
         if (existing) {
            report.present.push(name);
            continue;
         }
         await sql`
            INSERT INTO agents (workspace_id, name, description, status, capabilities,
                                model_provider, model_name, model_tier, instructions, runtime_id)
            VALUES (${workspaceId}, ${name},
                    ${`${model.displayName} — $${model.inputCostPerM}/$${model.outputCostPerM} per million tokens in/out.`},
                    'unknown', ARRAY['file_list', 'file_read', 'file_write']::text[],
                    ${model.provider}, ${model.id}, ${model.tier},
                    ${instructionsFor(model)}, ${runtimeId})`;
         report.created.push(name);
      }
      reports.push(report);
   }
   return reports;
}

function instructionsFor(model: CatalogModel): string {
   return `You are ${model.displayName}, one of a fleet of agents that differ only by the model behind them.

You exist so a person can put the same task to several models and compare what
comes back. Answer the task you are given, as directly as you can. When you
cannot do something, say which part and why, rather than approximating it and
reporting success.

Keep answers short unless the task asks for length.`;
}
