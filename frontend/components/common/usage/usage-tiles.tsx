'use client';

import { useTranslations } from 'next-intl';

import {
   formatCost,
   formatDuration,
   formatTokens,
   type RunTotals,
   type UsageBucket,
} from '@/lib/usage';

/**
 * What a window cost and what it took: money, tokens, and — when the read
 * carries them — the runs behind both.
 */
export function UsageTiles({ totals, runs }: { totals: UsageBucket; runs?: RunTotals }) {
   const t = useTranslations('areas.usage.tiles');
   const tiles = [
      { label: t('cost'), value: formatCost(totals.costMicros) },
      { label: t('tokens'), value: formatTokens(totals.inputTokens + totals.outputTokens) },
      {
         label: t('cache'),
         value: `${formatTokens(totals.cacheReadTokens)} / ${formatTokens(totals.cacheWriteTokens)}`,
      },
      ...(runs
         ? [
              { label: t('runs'), value: String(runs.runs) },
              { label: t('runTime'), value: formatDuration(runs.runSeconds) },
           ]
         : []),
   ];
   return (
      <div className="flex flex-col gap-2">
         <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {tiles.map((tile) => (
               <div key={tile.label} className="rounded-md border px-4 py-3">
                  <p className="text-muted-foreground">{tile.label}</p>
                  <p className="mt-1 font-medium tabular-nums">{tile.value}</p>
               </div>
            ))}
         </div>
         {totals.unpricedEvents > 0 ? (
            <p className="text-muted-foreground">
               {t('unpriced', { unpriced: totals.unpricedEvents, events: totals.events })}
            </p>
         ) : null}
      </div>
   );
}
