import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { toRFC3339, type Sql } from '../db/pool.ts';
import { costMicrosFor, type PricingSource } from '../agents/pricing.ts';

/**
 * Model usage, recorded as it is reported.
 *
 * One row per report (a `task.usage` lifecycle event, or one in-process run),
 * priced on write from the same feed the model picker shows. The hourly
 * rollup, the run's totals and a workspace-stream event are written in the
 * same transaction, so the Usage page, the run and the dashboard can never
 * disagree about what was spent.
 */

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const taskUsageInputSchema = z.object({
   runId: z.uuid(),
   workspaceId: z.uuid(),
   agentId: z.uuid(),
   runtimeId: z.uuid().optional(),
   model: z.string().min(1).max(300),
   inputTokens: tokens,
   outputTokens: tokens,
   cacheReadTokens: tokens,
   cacheWriteTokens: tokens,
});

export type TaskUsageInput = z.infer<typeof taskUsageInputSchema>;

/** The run is absent, or belongs to a different workspace than the report claims. */
export class UsageRunMismatch extends Error {
   constructor(runId: string) {
      super(`run ${runId} is not in the reporting workspace`);
      this.name = 'UsageRunMismatch';
   }
}

let pricing: PricingSource | null = null;

/**
 * Where costs come from. Set once by the composition root. Null means usage
 * is recorded unpriced, which a reader shows as "no price" rather than as free.
 */
export function configureUsagePricing(source: PricingSource | null): void {
   pricing = source;
}

async function priceOf(model: string, counts: TaskUsageInput): Promise<number | null> {
   if (!pricing) return null;
   try {
      const price = await pricing.priceFor(model);
      return price ? costMicrosFor(price, counts) : null;
   } catch {
      // A price lookup is never a reason to lose the usage itself.
      return null;
   }
}

export async function recordTaskUsage(sql: Sql, input: TaskUsageInput): Promise<void> {
   const usage = taskUsageInputSchema.parse(input);
   const costMicros = await priceOf(usage.model, usage);
   const currency = costMicros === null ? null : 'USD';
   const runtimeId = usage.runtimeId ?? null;
   const id = randomUUID();

   await sql.begin(async (transaction) => {
      const tx = transaction as unknown as Sql;

      // The run's workspace is re-derived rather than trusted: a report naming
      // a run in another workspace would otherwise bill that workspace's chart.
      // LEFT JOIN, so a run without a board (a completion task) is accepted on
      // the reported workspace alone.
      const [row] = await tx`
         INSERT INTO task_usage (
            id, workspace_id, run_id, issue_id, agent_id, runtime_id, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            cost_micros, currency
         )
         SELECT ${id}, ${usage.workspaceId}, r.id, r.issue_id, ${usage.agentId}, ${runtimeId},
                ${usage.model}, ${usage.inputTokens}, ${usage.outputTokens},
                ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, ${costMicros}, ${currency}
           FROM runs AS r
           LEFT JOIN boards AS b ON b.id = r.board_id
          WHERE r.id = ${usage.runId}
            AND COALESCE(b.workspace_id, ${usage.workspaceId}::uuid) = ${usage.workspaceId}
         RETURNING occurred_at, issue_id`;
      if (!row) throw new UsageRunMismatch(usage.runId);
      const occurredAt = row.occurred_at as string;
      const issueId = (row.issue_id as string | null) ?? null;

      await tx`
         INSERT INTO task_usage_hourly (
            workspace_id, bucket, agent_id, runtime_id, model, events, unpriced_events,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros
         ) VALUES (
            ${usage.workspaceId}, date_trunc('hour', ${occurredAt}::timestamptz, 'UTC'),
            ${usage.agentId}, ${runtimeId}, ${usage.model}, 1, ${costMicros === null ? 1 : 0},
            ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens},
            ${usage.cacheWriteTokens}, ${costMicros ?? 0}
         )
         ON CONFLICT ON CONSTRAINT task_usage_hourly_key DO UPDATE SET
            events = task_usage_hourly.events + 1,
            unpriced_events = task_usage_hourly.unpriced_events + EXCLUDED.unpriced_events,
            input_tokens = task_usage_hourly.input_tokens + EXCLUDED.input_tokens,
            output_tokens = task_usage_hourly.output_tokens + EXCLUDED.output_tokens,
            cache_read_tokens = task_usage_hourly.cache_read_tokens + EXCLUDED.cache_read_tokens,
            cache_write_tokens = task_usage_hourly.cache_write_tokens + EXCLUDED.cache_write_tokens,
            cost_micros = task_usage_hourly.cost_micros + EXCLUDED.cost_micros,
            updated_at = now()`;

      // Recomputed from the record rather than incremented, so a retried or
      // reordered write cannot drift the run away from its own rows. A run with
      // no priced report keeps a NULL cost: unknown, not free.
      await tx`
         UPDATE runs AS r
            SET input_tokens = t.input_tokens,
                output_tokens = t.output_tokens,
                total_tokens = t.input_tokens + t.output_tokens,
                cost_micros = t.cost_micros,
                currency = CASE WHEN t.cost_micros IS NULL THEN NULL ELSE 'USD' END
           FROM (
              SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                     COALESCE(SUM(output_tokens), 0) AS output_tokens,
                     SUM(cost_micros) AS cost_micros
                FROM task_usage WHERE run_id = ${usage.runId}
           ) AS t
          WHERE r.id = ${usage.runId}`;

      const eventId = randomUUID();
      const payload = {
         runId: usage.runId,
         issueId,
         agentId: usage.agentId,
         runtimeId,
         model: usage.model,
         inputTokens: usage.inputTokens,
         outputTokens: usage.outputTokens,
         cacheReadTokens: usage.cacheReadTokens,
         cacheWriteTokens: usage.cacheWriteTokens,
         costMicros,
      };
      const envelope = {
         id: eventId,
         type: 'usage.recorded',
         occurredAt: toRFC3339(occurredAt),
         workspaceId: usage.workspaceId,
         // Workspace-level, like goals: usage belongs to no board's replay.
         boardId: null,
         aggregateType: 'run',
         aggregateId: usage.runId,
         payload,
      };
      await tx`
         INSERT INTO outbox_events (
            id, topic, aggregate_type, aggregate_id, workspace_id, board_id,
            payload, occurred_at, available_at
         ) VALUES (
            ${eventId}, 'usage.recorded', 'run', ${usage.runId}, ${usage.workspaceId}, NULL,
            ${tx.json(envelope as never)}, ${occurredAt}, ${occurredAt}
         )`;
   });
}
