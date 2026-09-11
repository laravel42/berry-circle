'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { Button } from '@/components/ui/button';
import { localTimezone } from '@/lib/cron-schedule';
import { USAGE_DAY_OPTIONS, getDashboard } from '@/lib/usage';
import { useSessionStore } from '@/store/session-store';

import { UsageDailyChart } from './usage-daily-chart';
import { useUsage } from './use-usage';

const TASK_KEYS = [
   'backlog',
   'todo',
   'inProgress',
   'inReview',
   'blocked',
   'done',
   'cancelled',
] as const;

const RUN_STATUSES = ['running', 'queued', 'succeeded', 'failed', 'cancelled'] as const;

/** The workspace at a glance: what is running, what failed, what it cost, where tasks stand. */
export default function DashboardOverview() {
   const t = useTranslations('areas.dashboard');
   const { orgId } = useParams<{ orgId: string }>();
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? null);
   const [days, setDays] = useState<number>(30);
   const { data, error } = useUsage(
      workspaceId ? () => getDashboard(workspaceId, { days, timezone: localTimezone() }) : null,
      `${workspaceId}:${days}`
   );

   const taskLabel = (status: string) =>
      (TASK_KEYS as readonly string[]).includes(status)
         ? t(`task_${status as (typeof TASK_KEYS)[number]}`)
         : status;

   return (
      <div className="flex flex-col gap-8 px-6 py-6">
         <div className="flex w-fit items-center gap-1 rounded-md border p-0.5">
            {USAGE_DAY_OPTIONS.map((option) => (
               <Button
                  key={option}
                  size="xxs"
                  variant={option === days ? 'secondary' : 'ghost'}
                  onClick={() => setDays(option)}
               >
                  {t('days', { count: option })}
               </Button>
            ))}
         </div>
         {error ? <p className="text-muted-foreground">{error}</p> : null}
         {data ? (
            <>
               <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  {RUN_STATUSES.map((status) => (
                     <div key={status} className="rounded-md border px-4 py-3">
                        <p className="text-muted-foreground">{t(`status_${status}`)}</p>
                        <p className="mt-1 font-medium tabular-nums">{data.runCounts[status]}</p>
                     </div>
                  ))}
               </div>

               <section>
                  <h3 className="mb-2 font-medium">{t('runsByDay')}</h3>
                  <div className="h-48 w-full">
                     <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                           data={data.runsDaily.map((row) => ({ ...row, key: row.day.slice(5) }))}
                           margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
                        >
                           <XAxis
                              dataKey="key"
                              tickLine={false}
                              axisLine={false}
                              fontSize={11}
                              minTickGap={12}
                           />
                           <YAxis hide allowDecimals={false} />
                           <Tooltip cursor={{ fillOpacity: 0.08 }} />
                           <Bar
                              dataKey="succeeded"
                              stackId="runs"
                              fill="var(--color-status-success, currentColor)"
                           />
                           <Bar
                              dataKey="failed"
                              stackId="runs"
                              fill="var(--color-status-error, currentColor)"
                           />
                           <Bar
                              dataKey="cancelled"
                              stackId="runs"
                              fill="var(--color-muted-foreground, currentColor)"
                           />
                        </BarChart>
                     </ResponsiveContainer>
                  </div>
               </section>

               <section>
                  <h3 className="mb-2 font-medium">{t('costByDay')}</h3>
                  <UsageDailyChart points={data.usageDaily} metric="cost" />
               </section>

               <div className="grid gap-8 lg:grid-cols-2">
                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">{t('workingNow')}</h3>
                     {data.workingAgents.length === 0 ? (
                        <p className="text-muted-foreground">{t('noneWorking')}</p>
                     ) : (
                        <ul className="flex flex-col gap-1.5">
                           {data.workingAgents.map((row) => (
                              <li key={row.runId} className="flex items-center justify-between gap-3">
                                 <Link
                                    href={`/${orgId}/agents/${row.agentId}`}
                                    className="shrink-0 hover:underline"
                                 >
                                    {row.agentName}
                                 </Link>
                                 <Link
                                    href={`/${orgId}/runs?run=${row.runId}`}
                                    className="truncate text-muted-foreground hover:underline"
                                 >
                                    {row.issueTitle}
                                 </Link>
                              </li>
                           ))}
                        </ul>
                     )}
                  </section>

                  <section className="flex flex-col gap-2">
                     <h3 className="font-medium">{t('failuresByAgent')}</h3>
                     {data.failuresByAgent.length === 0 ? (
                        <p className="text-muted-foreground">{t('noFailures')}</p>
                     ) : (
                        <ul className="flex flex-col gap-1.5">
                           {data.failuresByAgent.map((row) => (
                              <li
                                 key={row.agentId}
                                 className="flex items-center justify-between gap-3"
                              >
                                 <Link
                                    href={`/${orgId}/agents/${row.agentId}`}
                                    className="hover:underline"
                                 >
                                    {row.agentName}
                                 </Link>
                                 <span className="tabular-nums text-muted-foreground">
                                    {t('failedOf', { failed: row.failed, total: row.total })}
                                 </span>
                              </li>
                           ))}
                        </ul>
                     )}
                  </section>
               </div>

               <section className="flex flex-col gap-2">
                  <h3 className="font-medium">{t('tasksNow')}</h3>
                  <div className="flex flex-wrap gap-2">
                     {Object.entries(data.taskSnapshot).map(([status, count]) => (
                        <span key={status} className="rounded-md border px-3 py-1.5">
                           {taskLabel(status)}{' '}
                           <span className="tabular-nums text-muted-foreground">{count}</span>
                        </span>
                     ))}
                  </div>
               </section>
            </>
         ) : null}
      </div>
   );
}
