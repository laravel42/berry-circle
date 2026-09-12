'use client';

import { RunTranscriptDialog } from '@/components/common/runs/transcript-dialog';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import {
   cancelRun,
   createIssueRun,
   formatRunDuration,
   isTerminalRunStatus,
   orderRunsForLog,
   retryOrdinal,
   runDurationMs,
   runTriggerKey,
   type RunRecord,
} from '@/lib/runs';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useMembersStore } from '@/store/members-store';
import { ChevronDown, ChevronRight, RotateCcw, ScrollText, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

/**
 * Every run this task has had.
 *
 * The activity feed already says a run happened, but it says it in the middle
 * of everything else and only once. What an operator asks of a task with six
 * runs behind it is a different question — which of these is still going, what
 * started each one, who asked, and why did that one stop — and that is a list,
 * ordered by relevance rather than by time: whatever is running now, then the
 * history behind a fold.
 */

function statusTone(status: RunRecord['status']): string {
   switch (status) {
      case 'succeeded':
         return 'text-status-success';
      case 'failed':
         return 'text-status-danger';
      case 'cancelled':
         return 'text-status-neutral';
      case 'running':
         return 'text-status-info';
      default:
         return 'text-muted-foreground';
   }
}

function RunRow({
   run,
   all,
   onCancel,
   onRetry,
   onTranscript,
   busy,
}: {
   run: RunRecord;
   all: RunRecord[];
   onCancel: (run: RunRecord) => void;
   onRetry: (run: RunRecord) => void;
   onTranscript: (run: RunRecord) => void;
   busy: boolean;
}) {
   const t = useTranslations('issueDetail.log');
   const getAgentById = useAgentsStore((state) => state.getAgentById);
   const getMemberById = useMembersStore((state) => state.getMemberById);

   const agent = getAgentById(run.agentId);
   const retries = retryOrdinal(all, run);
   const trigger =
      retries > 0
         ? t('trigger.retry', { count: retries })
         : t(`trigger.${runTriggerKey(run.source)}` as 'trigger.assignment');
   const asker = run.requestedBy ? getMemberById(run.requestedBy.id)?.name : undefined;
   const duration = runDurationMs(run);

   // The plain-language part. A failure code is what the server knows; what a
   // reader needs is the sentence, and a cancelled run needs one too because
   // "cancelled" alone reads like something went wrong.
   const reason =
      run.status === 'failed'
         ? t('reasonFailed', { reason: run.failure?.message || t('reasonUnknown') })
         : run.status === 'cancelled'
           ? t('reasonCancelled')
           : null;

   return (
      <li className="flex flex-col gap-1 border-b border-border/50 py-2 last:border-b-0">
         <div className="flex min-w-0 items-center gap-2">
            <span className={cn('shrink-0 capitalize', statusTone(run.status))}>{run.status}</span>
            <span className="min-w-0 truncate">{agent?.name ?? t('trigger.assignment')}</span>
            {duration !== null ? (
               <span className="shrink-0 text-muted-foreground">{formatRunDuration(duration)}</span>
            ) : null}
         </div>
         <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-muted-foreground">
            <span className="rounded bg-accent px-1.5">{trigger}</span>
            <span className="truncate">{asker ? t('by', { name: asker }) : t('bySystem')}</span>
         </div>
         {reason ? <p className="text-muted-foreground">{reason}</p> : null}
         <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="xs" onClick={() => onTranscript(run)}>
               <ScrollText className="mr-1 size-3.5" />
               {t('transcript')}
            </Button>
            {isTerminalRunStatus(run.status) ? (
               <Button variant="ghost" size="xs" disabled={busy} onClick={() => onRetry(run)}>
                  <RotateCcw className="mr-1 size-3.5" />
                  {t('retry')}
               </Button>
            ) : (
               <Button variant="ghost" size="xs" disabled={busy} onClick={() => onCancel(run)}>
                  <X className="mr-1 size-3.5" />
                  {t('cancel')}
               </Button>
            )}
         </div>
      </li>
   );
}

export function ExecutionLog({
   issueId,
   runs,
   onRunsChanged,
}: {
   issueId: string;
   /** Every run on this task; the section decides what to show and in what order. */
   runs: RunRecord[];
   onRunsChanged: (run: RunRecord) => void;
}) {
   const t = useTranslations('issueDetail.log');
   const getAgentById = useAgentsStore((state) => state.getAgentById);
   const [showPast, setShowPast] = useState(false);
   const [confirming, setConfirming] = useState<RunRecord | null>(null);
   const [busy, setBusy] = useState(false);
   const [transcript, setTranscript] = useState<RunRecord | null>(null);

   const { active, past } = useMemo(() => orderRunsForLog(runs), [runs]);

   const doCancel = async () => {
      if (!confirming) return;
      setBusy(true);
      try {
         onRunsChanged(await cancelRun(confirming.id));
         toast.success(t('cancelled'));
         setConfirming(null);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('cancelFailed'));
      } finally {
         setBusy(false);
      }
   };

   const doRetry = async (run: RunRecord) => {
      setBusy(true);
      try {
         onRunsChanged(await createIssueRun(issueId, { agentId: run.agentId }));
         toast.success(t('retried'));
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('retryFailed'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <Section title={t('title')}>
         {runs.length === 0 ? (
            <p className="text-muted-foreground">{t('empty')}</p>
         ) : (
            <>
               {active.length > 0 ? (
                  <>
                     <div className="mb-1 text-muted-foreground">{t('active')}</div>
                     <ul className="mb-2 flex flex-col">
                        {active.map((run) => (
                           <RunRow
                              key={run.id}
                              run={run}
                              all={runs}
                              busy={busy}
                              onCancel={setConfirming}
                              onRetry={(target) => void doRetry(target)}
                              onTranscript={setTranscript}
                           />
                        ))}
                     </ul>
                  </>
               ) : null}

               {past.length > 0 ? (
                  <>
                     <Button
                        variant="ghost"
                        size="xs"
                        className="-ml-2"
                        aria-expanded={showPast}
                        onClick={() => setShowPast((value) => !value)}
                     >
                        {showPast ? (
                           <ChevronDown className="mr-1 size-3.5" />
                        ) : (
                           <ChevronRight className="mr-1 size-3.5" />
                        )}
                        {showPast ? t('hidePast') : t('pastCount', { count: past.length })}
                     </Button>
                     {showPast ? (
                        <ul className="flex flex-col">
                           {past.map((run) => (
                              <RunRow
                                 key={run.id}
                                 run={run}
                                 all={runs}
                                 busy={busy}
                                 onCancel={setConfirming}
                                 onRetry={(target) => void doRetry(target)}
                                 onTranscript={setTranscript}
                              />
                           ))}
                        </ul>
                     ) : null}
                  </>
               ) : null}
            </>
         )}

         <AlertDialog
            open={confirming !== null}
            onOpenChange={(open) => (open ? undefined : setConfirming(null))}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('cancelTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('cancelBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>{t('keepRunning')}</AlertDialogCancel>
                  <AlertDialogAction
                     disabled={busy}
                     onClick={(event) => {
                        event.preventDefault();
                        void doCancel();
                     }}
                  >
                     {t('confirmCancel')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <RunTranscriptDialog
            runId={transcript?.id ?? null}
            open={transcript !== null}
            agentName={
               transcript ? (getAgentById(transcript.agentId)?.name ?? undefined) : undefined
            }
            onOpenChange={(open) => (open ? undefined : setTranscript(null))}
         />
      </Section>
   );
}

export default ExecutionLog;
