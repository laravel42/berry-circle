'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CheckCircle2, Clock3, LoaderCircle, XCircle } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { agentTaskDurationMs, type AgentTask } from '@/lib/agents';
import { cancelRun, formatRunDuration } from '@/lib/runs';

interface AgentActivityTabProps {
   tasks: AgentTask[] | null;
   /** Null when there is no further page. */
   cursor: string | null;
   loadingMore: boolean;
   onLoadMore: () => void;
   /** Re-read after a cancellation, so the lists move the run across. */
   onChanged: () => void;
}

function StatusIcon({ status }: { status: string }) {
   if (status === 'succeeded')
      return <CheckCircle2 className="size-4 text-[#00cc66]" aria-hidden />;
   if (status === 'failed') return <XCircle className="size-4 text-destructive" aria-hidden />;
   if (status === 'running' || status === 'queued') {
      return <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />;
   }
   return <Clock3 className="size-4 text-muted-foreground" aria-hidden />;
}

/**
 * What this agent is doing, and what it did.
 *
 * Runs are paged in from the newest backwards rather than loaded whole: an
 * agent that has been working for months has thousands, and the reader's
 * question is almost always about the last few.
 */
export default function AgentActivityTab({
   tasks,
   cursor,
   loadingMore,
   onLoadMore,
   onChanged,
}: AgentActivityTabProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const t = useTranslations('agentsChat.detail');
   const common = useTranslations('agentsChat.common');
   const format = useFormatter();
   const [cancelling, setCancelling] = useState<string | null>(null);
   const [expanded, setExpanded] = useState<string | null>(null);

   /**
    * A failure in the words of someone who has to decide what to do next.
    *
    * The raw code is kept behind "details" rather than shown: `RUNTIME_5XX`
    * tells a reader nothing they can act on, and hiding it entirely would
    * leave the one person who can act on it with nothing to go on.
    */
   const explain = (task: AgentTask): string => {
      const code = (task.failure?.code ?? '').toUpperCase();
      if (task.status === 'cancelled') return t('failureCancelled');
      if (code.includes('TIMEOUT') || code.includes('DEADLINE')) return t('failureTimeout');
      if (code.includes('RUNTIME') || code.includes('UNAVAILABLE') || code.includes('DEPENDENCY')) {
         return t('failureRuntime');
      }
      return t('failureUnknown');
   };

   const cancel = async (task: AgentTask) => {
      setCancelling(task.id);
      try {
         await cancelRun(task.id);
         toast.success(t('activityCancelled'));
         onChanged();
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('failureUnknown'));
      } finally {
         setCancelling(null);
      }
   };

   if (!tasks) return <p className="px-8 py-6 text-muted-foreground">{common('loading')}</p>;

   const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
   const finished = tasks.filter((task) => task.status !== 'queued' && task.status !== 'running');

   return (
      <div className="flex max-w-4xl flex-col gap-8 px-8 py-6">
         <section>
            <h2 className="font-medium">{t('activityNow')}</h2>
            {active.length === 0 ? (
               <p className="mt-3 text-muted-foreground">{t('activityNoActive')}</p>
            ) : (
               <div className="mt-3 flex flex-col gap-2">
                  {active.map((task) => (
                     <div
                        key={task.id}
                        className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-4 py-3"
                     >
                        <StatusIcon status={task.status} />
                        <div className="min-w-0 flex-1">
                           <p className="truncate font-medium">
                              {task.summary?.trim() || task.id.slice(0, 8)}
                           </p>
                           <p className="text-muted-foreground">
                              {/* The trigger, in the only terms the wire knows:
                                  work that came from an issue, or from a chat. */}
                              {t('activitySource', {
                                 source: task.issueId ? 'issue' : 'chat',
                              })}
                           </p>
                        </div>
                        {task.issueId ? (
                           <Link
                              href={`/${orgId}/issue/${task.issueId}`}
                              className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                           >
                              {t('activityOpenIssue')}
                           </Link>
                        ) : null}
                        {/* Until F2's transcript dialog is merged this links to
                            the run ledger, which shows the same events. */}
                        <Link
                           href={`/${orgId}/runs?run=${task.id}`}
                           className="shrink-0 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                           {t('activityTranscript')}
                        </Link>
                        <Button
                           size="xs"
                           variant="ghost"
                           className="shrink-0"
                           disabled={cancelling === task.id}
                           onClick={() => void cancel(task)}
                        >
                           {t('activityCancel')}
                        </Button>
                     </div>
                  ))}
               </div>
            )}
         </section>

         <section>
            <h2 className="font-medium">{t('activityRecent')}</h2>
            {finished.length === 0 ? (
               <p className="mt-3 text-muted-foreground">{t('activityNoRecent')}</p>
            ) : (
               <div className="mt-3 flex flex-col">
                  {finished.map((task) => {
                     const duration = agentTaskDurationMs(task);
                     const failed = task.status === 'failed' || task.status === 'cancelled';
                     return (
                        <div
                           key={task.id}
                           className="flex flex-col gap-1 border-b border-border/60 py-3 last:border-b-0"
                        >
                           <div className="flex items-start gap-3">
                              <StatusIcon status={task.status} />
                              <div className="min-w-0 flex-1">
                                 <p className="text-muted-foreground">
                                    {format.relativeTime(new Date(task.createdAt))}
                                 </p>
                                 <p className="mt-0.5 truncate">
                                    {task.summary?.trim() || task.id.slice(0, 8)}
                                 </p>
                                 {failed ? (
                                    <p className="mt-0.5 text-muted-foreground">{explain(task)}</p>
                                 ) : null}
                              </div>
                              <div className="shrink-0 text-right text-muted-foreground">
                                 {duration !== null ? <p>{formatRunDuration(duration)}</p> : null}
                                 <Link
                                    href={`/${orgId}/runs?run=${task.id}`}
                                    className="underline-offset-2 hover:text-foreground hover:underline"
                                 >
                                    {t('activityTranscript')}
                                 </Link>
                              </div>
                           </div>
                           {failed && task.failure?.message ? (
                              <div className="pl-7">
                                 <button
                                    type="button"
                                    onClick={() =>
                                       setExpanded(expanded === task.id ? null : task.id)
                                    }
                                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                                 >
                                    {t('failureDetails')}
                                 </button>
                                 {expanded === task.id ? (
                                    <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted/30 px-3 py-2 font-mono text-muted-foreground">
                                       {task.failure.code}: {task.failure.message}
                                    </p>
                                 ) : null}
                              </div>
                           ) : null}
                        </div>
                     );
                  })}
               </div>
            )}
            {cursor ? (
               <Button
                  size="xs"
                  variant="secondary"
                  className="mt-3"
                  disabled={loadingMore}
                  onClick={onLoadMore}
               >
                  {t('activityMore')}
               </Button>
            ) : null}
         </section>
      </div>
   );
}
