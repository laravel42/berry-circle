'use client';

import { parseISO } from 'date-fns';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { GitBranch, GitPullRequest } from 'lucide-react';
import { BerryApiError } from '@/lib/api';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   cancelRun,
   deliveryFromRunEvent,
   isTerminalRunEvent,
   isTerminalRunStatus,
   loadBoardRuns,
   streamRunEvents,
   type RunDelivery,
   type RunRecord,
} from '@/lib/runs';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
import { RunTranscriptDialog } from '@/components/common/runs/transcript-dialog';
import { useSessionStore } from '@/store/session-store';
import { toast } from 'sonner';

const COLUMNS = ['issue', 'assignee', 'state'] as const;

function oneLine(value: string | null | undefined): string {
   return value?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Compact relative time so the state column can stay one line without clipping. */
function relativeTime(value: string | null | undefined): string {
   if (!value) return '';
   try {
      const then = parseISO(value).getTime();
      if (Number.isNaN(then)) return '';
      const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
      if (minutes < 1) return 'just now';
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      if (days < 14) return `${days}d ago`;
      const weeks = Math.round(days / 7);
      if (weeks < 8) return `${weeks}w ago`;
      return `${Math.round(days / 30)}mo ago`;
   } catch {
      return '';
   }
}

function runWhen(run: RunRecord): string {
   return relativeTime(run.completedAt ?? run.startedAt ?? run.createdAt);
}

/**
 * What the run left behind: the branch, the diff, and the pull request.
 *
 * The run resource carries none of this — it is in the ledger, on the
 * `run.delivered` frame — and without it a person watching a run sees the
 * agent finish and has no way to reach the work. A run that changed nothing
 * says so, because that is a real outcome and not a missing one.
 */
function DeliveryStrip({ delivery }: { delivery: RunDelivery }) {
   if (!delivery.committed) {
      return (
         <p className="mt-3 border-t border-border/60 pt-3 text-muted-foreground">
            No files changed.
         </p>
      );
   }
   return (
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border/60 pt-3">
         <span className="inline-flex items-center gap-1.5">
            <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-mono">{delivery.branch}</span>
         </span>
         <span className="text-muted-foreground">
            {delivery.filesChanged} file{delivery.filesChanged === 1 ? '' : 's'}
            {' · '}
            <span className="text-status-success">+{delivery.insertions}</span>
            {' '}
            <span className="text-status-danger">−{delivery.deletions}</span>
         </span>
         {delivery.pullRequest ? (
            <a
               href={delivery.pullRequest.url}
               target="_blank"
               rel="noreferrer"
               className="inline-flex items-center gap-1.5 underline underline-offset-2"
            >
               <GitPullRequest className="size-3.5 shrink-0" />#{delivery.pullRequest.number}
               <span className="text-muted-foreground">
                  {delivery.pullRequest.created ? 'opened' : 'updated'}
               </span>
            </a>
         ) : null}
         {delivery.mergeRequiresApproval ? (
            <span className="text-muted-foreground">A person has to merge it.</span>
         ) : null}
      </div>
   );
}

export default function RunOverview() {
   const t = useTranslations('runtimes.overview');
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const searchParams = useSearchParams();
   const boardId = useSessionStore((state) => state.boardId);
   const issues = useIssuesStore((state) => state.issues);
   const getAgentById = useAgentsStore((state) => state.getAgentById);
   const runs = useRunsStore((state) => state.runs);
   const runsError = useRunsStore((state) => state.error);
   const hydrateRuns = useRunsStore((state) => state.hydrateRuns);
   const upsertRun = useRunsStore((state) => state.upsertRun);

   const [selectedRunId, setSelectedRunId] = useState<string | null>(searchParams.get('run'));
   const [transcriptOpen, setTranscriptOpen] = useState(false);
   const [delivery, setDelivery] = useState<RunDelivery | null>(null);
   const [streamStatus, setStreamStatus] = useState<string>('');
   const [cancelling, setCancelling] = useState(false);

   const selectedRun = runs.find((run) => run.id === selectedRunId);

   useEffect(() => {
      const fromQuery = searchParams.get('run');
      if (fromQuery) setSelectedRunId(fromQuery);
   }, [searchParams]);

   useEffect(() => {
      if (!boardId || runs.length > 0 || runsError) return;
      let cancelled = false;
      void loadBoardRuns(boardId, { first: 200 }).then((found) => {
         if (!cancelled) hydrateRuns(found, null);
      });
      return () => {
         cancelled = true;
      };
   }, [boardId, runs.length, runsError, hydrateRuns]);

   useEffect(() => {
      if (!selectedRunId) {
         setStreamStatus('');
         return;
      }
      const controller = new AbortController();
      setDelivery(null);
      setStreamStatus('listening');
      void (async () => {
         try {
            for await (const event of streamRunEvents(selectedRunId, controller.signal)) {
               // What the run left behind. Read from the frame rather than
               // from the run record, because the run resource carries no
               // branch or pull request — the ledger is where they are.
               const delivered = deliveryFromRunEvent(event);
               if (delivered) setDelivery(delivered);
               if (event.type === 'run.started') setStreamStatus('running');
               if (isTerminalRunEvent(event.type)) {
                  setStreamStatus(event.type.replace('run.', ''));
                  if (boardId) {
                     void loadBoardRuns(boardId, { first: 200 }).then((found) => hydrateRuns(found));
                  }
                  return;
               }
            }
         } catch (error) {
            if (controller.signal.aborted) return;
            setStreamStatus(error instanceof BerryApiError ? error.message : 'stream interrupted');
         }
      })();
      return () => controller.abort();
   }, [selectedRunId, boardId, hydrateRuns]);

   const issueById = useMemo(() => {
      return new Map(issues.map((issue) => [issue.id, issue]));
   }, [issues]);

   const visibleRuns = useMemo(() => {
      return runs.filter((run) => {
         const issue = issueById.get(run.issueId);
         return Boolean(issue?.title?.trim() || run.summary?.trim());
      });
   }, [runs, issueById]);

   const onCancelSelected = async () => {
      if (!selectedRun || isTerminalRunStatus(selectedRun.status)) return;
      setCancelling(true);
      try {
         const updated = await cancelRun(selectedRun.id);
         upsertRun(updated);
         setStreamStatus('cancelled');
         toast.success(t('cancelled'));
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : t('cancelFailed'));
      } finally {
         setCancelling(false);
      }
   };

   return (
      <section className="flex h-full w-full flex-col" aria-label={t('label')}>
         {selectedRun ? (
            <div className="border-b bg-muted/20 px-6 py-5 sm:px-8">
               <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground">
                     {issueById.get(selectedRun.issueId)?.identifier ?? selectedRun.issueId} ·{' '}
                     {getAgentById(selectedRun.agentId)?.name ?? t('agentFallback')} ·{' '}
                     {streamStatus || selectedRun.status}
                  </p>
                  {!isTerminalRunStatus(selectedRun.status) ? (
                     <Button
                        variant="ghost"
                        size="sm"
                        className="h-8"
                        disabled={cancelling}
                        onClick={() => void onCancelSelected()}
                     >
                        {cancelling ? t('cancelling') : t('cancel')}
                     </Button>
                  ) : null}
               </div>
               {/* The one shared transcript, rather than this page's own copy
                   of it: a blob can only be scrolled, and "what did the agent
                   actually do" must not have two answers. */}
               <p className="mt-3 leading-6">
                  {selectedRun.summary || selectedRun.failure?.message || t('waiting')}
               </p>
               <Button
                  variant="secondary"
                  size="xs"
                  className="mt-3"
                  onClick={() => setTranscriptOpen(true)}
               >
                  {t('openTranscript')}
               </Button>
               {delivery ? <DeliveryStrip delivery={delivery} /> : null}
            </div>
         ) : null}

         <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed text-left">
               <caption className="sr-only">{t('caption')}</caption>
               <colgroup>
                  <col />
                  <col className="w-[120px]" />
                  <col className="w-[200px]" />
               </colgroup>
               <thead>
                  <tr className="border-b">
                     {COLUMNS.map((column) => (
                        <th
                           key={column}
                           scope="col"
                           className={cn(
                              'px-6 py-2.5 font-normal text-muted-foreground sm:px-8',
                              column === 'assignee' && 'w-[120px]',
                              column === 'state' && 'w-[200px]'
                           )}
                        >
                           {column}
                        </th>
                     ))}
                  </tr>
               </thead>
               <tbody>
                  {visibleRuns.length === 0 ? (
                     <tr>
                        <td
                           colSpan={COLUMNS.length}
                           className="px-6 py-12 leading-6 text-muted-foreground sm:px-8"
                        >
                           Nothing assigned.
                        </td>
                     </tr>
                  ) : (
                     visibleRuns.map((run) => {
                        const issue = issueById.get(run.issueId);
                        const agent = getAgentById(run.agentId);
                        const selected = selectedRunId === run.id;
                        const title = oneLine(issue?.title);
                        const preview = oneLine(run.summary);
                        const primary = title || preview;
                        const secondary = title && preview && preview !== title ? preview : '';
                        const status = isTerminalRunStatus(run.status)
                           ? run.status
                           : streamStatus && selected
                             ? streamStatus
                             : run.status;
                        const when = runWhen(run);
                        const openRun = () => {
                           setSelectedRunId(run.id);
                           router.replace(`/${orgId ?? WORKSPACE_SLUG}/runs?run=${run.id}`);
                        };
                        return (
                           <tr
                              key={run.id}
                              onClick={openRun}
                              className={cn(
                                 'cursor-pointer border-b border-border/60 transition-colors hover:bg-sidebar/50',
                                 selected && 'bg-accent/50'
                              )}
                           >
                              <td className="max-w-0 px-6 py-2.5 sm:px-8">
                                 <button
                                    type="button"
                                    onClick={openRun}
                                    aria-current={selected ? 'true' : undefined}
                                    title={secondary || preview || primary}
                                    className="flex w-full min-w-0 flex-col items-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                                 >
                                    <span className="flex min-w-0 items-baseline gap-2">
                                       {issue?.identifier ? (
                                          <span className="shrink-0 text-muted-foreground">
                                             {issue.identifier}
                                          </span>
                                       ) : null}
                                       <span className="min-w-0 truncate">{primary}</span>
                                    </span>
                                    {secondary ? (
                                       <span className="mt-0.5 truncate text-muted-foreground">
                                          {secondary}
                                       </span>
                                    ) : null}
                                 </button>
                              </td>
                              <td className="w-[120px] truncate px-6 py-2.5 text-muted-foreground sm:px-8">
                                 {agent?.name ?? t('agentFallback')}
                              </td>
                              <td className="w-[200px] px-6 py-2.5 text-muted-foreground sm:px-8">
                                 <span className="inline-flex w-fit items-baseline gap-1.5 whitespace-nowrap">
                                    <span className="capitalize">{status}</span>
                                    {when ? (
                                       <>
                                          <span aria-hidden>·</span>
                                          <span>{when}</span>
                                       </>
                                    ) : null}
                                 </span>
                              </td>
                           </tr>
                        );
                     })
                  )}
               </tbody>
            </table>
         </div>

         <RunTranscriptDialog
            runId={selectedRunId}
            open={transcriptOpen}
            onOpenChange={setTranscriptOpen}
            agentName={selectedRun ? getAgentById(selectedRun.agentId)?.name : undefined}
         />
      </section>
   );
}
