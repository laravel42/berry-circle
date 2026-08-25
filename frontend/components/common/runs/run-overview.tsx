'use client';

import { parseISO } from 'date-fns';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   cancelRun,
   isTerminalRunEvent,
   isTerminalRunStatus,
   loadBoardRuns,
   streamRunEvents,
   textFromRunEvent,
   type RunRecord,
} from '@/lib/runs';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
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

export default function RunOverview() {
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
   const [transcript, setTranscript] = useState('');
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
         setTranscript('');
         setStreamStatus('');
         return;
      }
      const controller = new AbortController();
      let output = '';
      setTranscript('');
      setStreamStatus('listening');
      void (async () => {
         try {
            for await (const event of streamRunEvents(selectedRunId, controller.signal)) {
               const chunk = textFromRunEvent(event);
               if (chunk) {
                  output += chunk;
                  setTranscript(output);
               }
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
         toast.success('Run cancelled');
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not cancel run');
      } finally {
         setCancelling(false);
      }
   };

   return (
      <section className="flex h-full w-full flex-col" aria-label="Runtimes">
         {selectedRun ? (
            <div className="border-b bg-muted/20 px-6 py-5 sm:px-8">
               <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground">
                     {issueById.get(selectedRun.issueId)?.identifier ?? selectedRun.issueId} ·{' '}
                     {getAgentById(selectedRun.agentId)?.name ?? 'agent'} ·{' '}
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
                        {cancelling ? 'Cancelling…' : 'Cancel run'}
                     </Button>
                  ) : null}
               </div>
               <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap leading-6">
                  {transcript ||
                     selectedRun.summary ||
                     selectedRun.failure?.message ||
                     'Waiting for output…'}
               </pre>
            </div>
         ) : null}

         <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full table-fixed text-left">
               <caption className="sr-only">Delegated runtimes</caption>
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
                                 {agent?.name ?? 'agent'}
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
      </section>
   );
}
