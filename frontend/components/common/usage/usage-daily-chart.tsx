'use client';

import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { formatCost, formatTokens, totalTokens, type UsageBucket } from '@/lib/usage';

/** One bar per bucket. Keys are days (`YYYY-MM-DD`) or hours (`00`..`23`). */
export function UsageDailyChart({
   points,
   metric,
}: {
   points: UsageBucket[];
   metric: 'cost' | 'tokens';
}) {
   const data = points.map((point) => ({
      key: point.key.length === 10 ? point.key.slice(5) : point.key,
      value: metric === 'cost' ? point.costMicros : totalTokens(point),
   }));
   const format = metric === 'cost' ? formatCost : formatTokens;
   return (
      <div className="h-48 w-full text-foreground/70">
         <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
               <XAxis
                  dataKey="key"
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  minTickGap={12}
               />
               <YAxis hide />
               <Tooltip
                  cursor={{ fillOpacity: 0.08 }}
                  formatter={(value) => [
                     format(Number(value)),
                     metric === 'cost' ? 'Cost' : 'Tokens',
                  ]}
               />
               <Bar dataKey="value" fill="currentColor" radius={[2, 2, 0, 0]} />
            </BarChart>
         </ResponsiveContainer>
      </div>
   );
}
