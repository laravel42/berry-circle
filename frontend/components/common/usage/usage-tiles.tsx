import { formatCost, formatTokens, type UsageBucket } from '@/lib/usage';

/** Cost and the four token counts for one window, with the unpriced caveat when it applies. */
export function UsageTiles({ totals }: { totals: UsageBucket }) {
   const tiles = [
      { label: 'Cost', value: formatCost(totals.costMicros) },
      { label: 'Input tokens', value: formatTokens(totals.inputTokens) },
      { label: 'Output tokens', value: formatTokens(totals.outputTokens) },
      {
         label: 'Cache read / write',
         value: `${formatTokens(totals.cacheReadTokens)} / ${formatTokens(totals.cacheWriteTokens)}`,
      },
   ];
   return (
      <div className="flex flex-col gap-2">
         <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {tiles.map((tile) => (
               <div key={tile.label} className="rounded-md border px-4 py-3">
                  <p className="text-muted-foreground">{tile.label}</p>
                  <p className="mt-1 font-medium tabular-nums">{tile.value}</p>
               </div>
            ))}
         </div>
         {totals.unpricedEvents > 0 ? (
            <p className="text-muted-foreground">
               {totals.unpricedEvents} of {totals.events} usage reports used a model with no
               published price. Their tokens are counted here; their cost is not.
            </p>
         ) : null}
      </div>
   );
}
