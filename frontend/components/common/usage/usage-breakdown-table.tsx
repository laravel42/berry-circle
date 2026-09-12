'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { formatCost, formatTokens, totalTokens, type UsageBucket } from '@/lib/usage';

export interface BreakdownRow {
   id: string;
   label: string;
   href?: string;
   bucket: UsageBucket;
}

/**
 * Rows ranked as the server sent them (by cost), with an honest empty state.
 * `ranked` numbers them, which is what makes a breakdown a leaderboard.
 */
export function UsageBreakdownTable({
   title,
   rows,
   ranked = false,
}: {
   title: string;
   rows: BreakdownRow[];
   ranked?: boolean;
}) {
   const t = useTranslations('areas.usage.breakdown');
   return (
      <section className="flex flex-col gap-2">
         <h3 className="font-medium">{title}</h3>
         {rows.length === 0 ? (
            <p className="text-muted-foreground">{t('empty')}</p>
         ) : (
            <div className="overflow-x-auto">
               <table className="w-full">
                  <thead className="text-left text-muted-foreground">
                     <tr>
                        {ranked ? <th className="py-1 pr-2 font-normal">#</th> : null}
                        <th className="py-1 pr-4 font-normal">{t('name')}</th>
                        <th className="py-1 pr-4 text-right font-normal">{t('reports')}</th>
                        <th className="py-1 pr-4 text-right font-normal">{t('tokens')}</th>
                        <th className="py-1 text-right font-normal">{t('cost')}</th>
                     </tr>
                  </thead>
                  <tbody>
                     {rows.map((row, index) => (
                        <tr key={row.id} className="border-t">
                           {ranked ? (
                              <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                                 {index + 1}
                              </td>
                           ) : null}
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
