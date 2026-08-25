'use client';

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
} from '@/lib/runs';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
import { useSessionStore } from '@/store/session-store';
import { toast } from 'sonner';

const COLUMNS = ['issue', 'assignee', 'state'] as const;

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
      <section className="flex h-full w-full flex-col" aria-label="Runs">
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
            <table className="w-full min-w-[36rem] text-left">
               <caption className="sr-only">Delegated runs</caption>
               <thead>
                  <tr className="border-b">
                     {COLUMNS.map((column) => (
                        <th
                           key={column}
                           scope="col"
                           className="px-6 py-2.5 font-normal text-muted-foreground sm:px-8"
                        >
                           {column}
                        </th>
                     ))}
                  </tr>
               </thead>
               <tbody>
                  {runs.length === 0 ? (
                     <tr>
                        <td
                           colSpan={COLUMNS.length}
                           className="px-6 py-12 leading-6 text-muted-foreground sm:px-8"
                        >
                           Nothing assigned.
                        </td>
                     </tr>
                  ) : (
                     runs.map((run) => {
                        const issue = issueById.get(run.issueId);
                        const agent = getAgentById(run.agentId);
                        return (
                           <tr key={run.id} className="border-b border-border/60">
                              <td className="px-6 py-3 sm:px-8">
                                 <button
                                    type="button"
                                    className="text-left hover:underline"
                                    onClick={() => {
                                       setSelectedRunId(run.id);
                                       router.replace(
                                          `/${orgId ?? WORKSPACE_SLUG}/runs?run=${run.id}`
                                       );
                                    }}
                                 >
                                    {issue?.identifier ?? run.issueId.slice(0, 8)}
                                    <span className="ml-2 text-muted-foreground">
                                       {issue?.title ?? run.summary ?? ''}
                                    </span>
                                 </button>
                              </td>
                              <td className="px-6 py-3 sm:px-8">
                                 {agent?.name ?? 'agent'}
                              </td>
                              <td className="px-6 py-3 capitalize text-muted-foreground sm:px-8">
                                 {isTerminalRunStatus(run.status)
                                    ? run.status
                                    : streamStatus && selectedRunId === run.id
                                      ? streamStatus
                                      : run.status}
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
