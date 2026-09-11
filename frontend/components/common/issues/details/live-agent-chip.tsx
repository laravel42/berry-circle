'use client';

import { BerryMark } from '@/components/brand/berry-mark';
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
   formatRunDuration,
   isTerminalRunEvent,
   isTerminalRunStatus,
   streamRunEvents,
   type RunRecord,
} from '@/lib/runs';
import { useAgentsStore } from '@/store/agents-store';
import { ScrollText, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * What an agent is doing to this task, right now.
 *
 * A task with an agent on it is not a static page, and nothing on it said so:
 * `activeRunId` sat on the model unused, so the only way to find out whether
 * something was happening was to reload and compare. The chip is deliberately
 * small and deliberately live — who, how long, how much it has done, and the
 * two things a person watching ever wants: see it, or stop it.
 */
export function LiveAgentChip({
   run,
   onRunChanged,
}: {
   /** The queued or running run; the chip renders nothing without one. */
   run: RunRecord | null;
   onRunChanged: (run: RunRecord) => void;
}) {
   const t = useTranslations('issueDetail.agentChip');
   const getAgentById = useAgentsStore((state) => state.getAgentById);
   const [toolCalls, setToolCalls] = useState(0);
   const [elapsed, setElapsed] = useState(0);
   const [confirming, setConfirming] = useState(false);
   const [transcript, setTranscript] = useState(false);
   const [busy, setBusy] = useState(false);

   const runId = run?.id ?? null;
   const startedAt = run?.startedAt ?? null;

   // The clock. A second is the right granularity: it is a progress signal,
   // not a stopwatch, and re-rendering the page more often than that to move
   // a duration would be a waste of a running agent's CPU.
   useEffect(() => {
      if (!startedAt) {
         setElapsed(0);
         return;
      }
      const tick = () => setElapsed(Math.max(0, Date.now() - new Date(startedAt).getTime()));
      tick();
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
   }, [startedAt]);

   // The work count comes from the stream rather than the run resource, which
   // carries no tool total — and the stream is what makes the chip live.
   useEffect(() => {
      if (!runId) {
         setToolCalls(0);
         return;
      }
      const controller = new AbortController();
      let calls = 0;
      setToolCalls(0);
      void (async () => {
         try {
            for await (const event of streamRunEvents(runId, controller.signal)) {
               if (event.type === 'run.tool.started' || event.type === 'run.command.started') {
                  calls += 1;
                  setToolCalls(calls);
               }
               if (isTerminalRunEvent(event.type)) return;
            }
         } catch {
            // A dropped stream stops the counter; it must not break the page.
         }
      })();
      return () => controller.abort();
   }, [runId]);

   if (!run || isTerminalRunStatus(run.status)) return null;

   const agentName = getAgentById(run.agentId)?.name ?? 'Agent';

   const stop = async () => {
      setBusy(true);
      try {
         onRunChanged(await cancelRun(run.id));
         toast.success(t('stopped'));
         setConfirming(false);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('stopFailed'));
      } finally {
         setBusy(false);
      }
   };

   return (
      <>
         <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-azure/30 bg-deep px-2 py-1 text-chalk">
            <BerryMark
               size="sm"
               tone="working"
               pulse
               bracketClassName="text-chalk"
               label={agentName}
            />
            <span className="min-w-0 truncate">
               {run.status === 'queued'
                  ? t('queued', { name: agentName })
                  : t('working', { name: agentName })}
            </span>
            {run.startedAt ? (
               <span className="shrink-0 text-ash tabular-nums">
                  {t('elapsed', { duration: formatRunDuration(elapsed) })}
               </span>
            ) : null}
            <span className="shrink-0 text-ash tabular-nums">
               {t('toolCalls', { count: toolCalls })}
            </span>
            <Button
               variant="ghost"
               size="xs"
               className="text-chalk hover:bg-chalk/10 hover:text-chalk"
               onClick={() => setTranscript(true)}
            >
               <ScrollText className="mr-1 size-3.5" />
               {t('viewTranscript')}
            </Button>
            <Button
               variant="ghost"
               size="xs"
               className="text-chalk hover:bg-chalk/10 hover:text-chalk"
               onClick={() => setConfirming(true)}
            >
               <X className="mr-1 size-3.5" />
               {t('stop')}
            </Button>
         </div>

         <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('stopTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                     {t('stopBody', { name: agentName })}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>{t('keepRunning')}</AlertDialogCancel>
                  <AlertDialogAction
                     disabled={busy}
                     onClick={(event) => {
                        event.preventDefault();
                        void stop();
                     }}
                  >
                     {t('stopConfirm')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>

         <RunTranscriptDialog
            runId={transcript ? run.id : null}
            open={transcript}
            agentName={agentName}
            onOpenChange={setTranscript}
         />
      </>
   );
}

export default LiveAgentChip;
