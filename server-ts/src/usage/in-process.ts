import type { AccountingSnapshot } from '../agents/runtime/plugins/accounting.ts';
import type { TaskUsageInput } from './record.ts';

/**
 * One in-process run's usage as a single usage report.
 *
 * The in-process loop reports once, at the end, because the accounting plugin
 * already sums every model call. The runtime path (workstream A) reports per
 * `task.usage` event instead. Both land in the same table.
 */
export function usageRecordFor(
   run: { runId: string; workspaceId: string; agentId: string; model: string },
   snapshot: Pick<AccountingSnapshot, 'usage' | 'modelCalls' | 'cacheReadTokens' | 'cacheWriteTokens'>
): TaskUsageInput | null {
   const { inputTokens, outputTokens } = snapshot.usage;
   const spent = inputTokens + outputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens;
   if (snapshot.modelCalls === 0 && spent === 0) return null;
   return {
      runId: run.runId,
      workspaceId: run.workspaceId,
      agentId: run.agentId,
      model: run.model,
      inputTokens,
      outputTokens,
      cacheReadTokens: snapshot.cacheReadTokens,
      cacheWriteTokens: snapshot.cacheWriteTokens,
   };
}
