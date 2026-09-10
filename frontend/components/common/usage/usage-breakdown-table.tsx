import Link from 'next/link';

import { formatCost, formatTokens, totalTokens, type UsageBucket } from '@/lib/usage';

export interface BreakdownRow {
   id: string;
   label: string;
   href?: string;
   bucket: UsageBucket;
}

/** Rows ranked as the server sent them (by cost), with an honest empty state. */
export function UsageBreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
   return (
      <section className="flex flex-col gap-2">
         <h3 className="font-medium">{title}</h3>
         {rows.length === 0 ? (
            <p className="text-muted-foreground">No usage in this window.</p>
         ) : (
            <div className="overflow-x-auto">
               <table className="w-full">
                  <thead className="text-left text-muted-foreground">
                     <tr>
                        <th className="py-1 pr-4 font-normal">Name</th>
                        <th className="py-1 pr-4 text-right font-normal">Reports</th>
                        <th className="py-1 pr-4 text-right font-normal">Tokens</th>
                        <th className="py-1 text-right font-normal">Cost</th>
                     </tr>
                  </thead>
                  <tbody>
                     {rows.map((row) => (
                        <tr key={row.id} className="border-t">
                           <td className="max-w-[20rem] truncate py-1.5 pr-4">
                              {row.href ? (
                                 <Link href={row.href} className="hover:underline">
                                    {row.label}
                                 </Link>
                              ) : (
                                 row.label
                              )}
                           </td>
                           <td className="py-1.5 pr-4 text-right tabular-nums">
                              {row.bucket.events}
                           </td>
                           <td className="py-1.5 pr-4 text-right tabular-nums">
                              {formatTokens(totalTokens(row.bucket))}
                           </td>
                           <td className="py-1.5 text-right tabular-nums">
                              {formatCost(row.bucket.costMicros)}
                              {row.bucket.unpricedEvents > 0 ? '*' : ''}
                           </td>
                        </tr>
                     ))}
                  </tbody>
               </table>
            </div>
         )}
      </section>
   );
}
