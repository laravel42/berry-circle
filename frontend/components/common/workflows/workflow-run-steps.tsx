'use client';

import { Pill } from '@/components/common/plans/plan-sections';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   describeRunEvent,
   describeStepType,
   describeWorkflowRunDuration,
   isTerminalWorkflowRunEvent,
   streamWorkflowRunEvents,
   type WorkflowRun,
   type WorkflowStepRun,
} from '@/lib/workflow-runs';
import type { EventEnvelope } from '@/lib/events';
import { BerryApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StepRunStatusMark } from './workflow-status-badge';

function timeText(iso: string | null | undefined): string {
   if (!iso) return '';
   try {
      return format(parseISO(iso), 'HH:mm:ss');
   } catch {
      return iso;
   }
}

function pretty(value: unknown): string | null {
   if (value === null || value === undefined) return null;
   if (typeof value === 'object' && Object.keys(value as object).length === 0) return null;
   try {
      return JSON.stringify(value, null, 2);
   } catch {
      return String(value);
   }
}

function Payload({ label, value }: { label: string; value: unknown }) {
   const text = pretty(value);
   if (!text) return null;
   return (
      <div className="min-w-0">
         <p className="text-muted-foreground">{label}</p>
         <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 font-mono leading-5">
            {text}
         </pre>
      </div>
   );
}

function StepRow({
   step,
   orgId,
   workflowId,
}: {
   step: WorkflowStepRun;
   orgId: string;
   workflowId: string;
}) {
   const issue = useIssuesStore((state) =>
      step.issueId ? state.issues.find((candidate) => candidate.id === step.issueId) : undefined
   );
   const duration = describeWorkflowRunDuration(step);
   const hasDetail =
      pretty(step.input) !== null || pretty(step.output) !== null || step.failure !== null;
   const links: { href: string; label: string }[] = [];
   if (step.issueId) {
      links.push({
         href: issue ? `/${orgId}/issue/${issue.identifier}` : `/${orgId}/issue/${step.issueId}`,
         label: issue ? `${issue.identifier} ${issue.title}` : 'task',
      });
   }
   if (step.runId) {
      links.push({ href: `/${orgId}/runs?run=${step.runId}`, label: 'agent run' });
   }
   if (step.approvalId) {
      links.push({ href: `/${orgId}/approvals?approval=${step.approvalId}`, label: 'approval' });
   }
   void workflowId;

   return (
      <li className="border-b border-border/60 last:border-b-0">
         <details className="group" open={step.status === 'failed'}>
            <summary
               className={cn(
                  'flex list-none items-start gap-3 px-1 py-2.5',
                  hasDetail && 'cursor-pointer hover:bg-accent/40'
               )}
            >
               <StepRunStatusMark status={step.status} className="mt-1" />
               <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                     <span className="font-medium">{describeStepType(step.stepType)}</span>
                     <span className="text-muted-foreground">{step.stepId}</span>
                     {step.attempt > 1 && <Pill>attempt {step.attempt}</Pill>}
                     {step.status === 'skipped' && <Pill>skipped</Pill>}
                     {step.status === 'waiting' && <Pill tone="attention">waiting</Pill>}
                  </div>
                  {step.failure && (
                     <p className="mt-0.5 text-status-danger">
                        {step.failure.code} · {step.failure.message}
                     </p>
                  )}
                  {links.length > 0 && (
                     <div className="mt-1 flex flex-wrap gap-1.5">
                        {links.map((link) => (
                           <Link
                              key={link.href}
                              href={link.href}
                              onClick={(event) => event.stopPropagation()}
                              className="inline-flex max-w-72 items-center rounded-md border border-border/60 px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                           >
                              <span className="truncate">{link.label}</span>
                           </Link>
                        ))}
                     </div>
                  )}
               </div>
               <span className="shrink-0 tabular-nums text-muted-foreground">
                  {duration ?? (step.startedAt ? timeText(step.startedAt) : '')}
               </span>
            </summary>
            {hasDetail && (
               <div className="grid gap-3 px-1 pb-3 pl-8 sm:grid-cols-2">
                  <Payload label="Input" value={step.input} />
                  <Payload label="Output" value={step.output} />
                  <Payload label="Failure" value={step.failure} />
               </div>
            )}
         </details>
      </li>
   );
}

/** The step attempts of one run, in the order they ran, each openable to its payloads. */
export function WorkflowRunSteps({ run }: { run: WorkflowRun }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const steps = run.steps ?? [];
   if (steps.length === 0) {
      return (
         <p className="text-muted-foreground">
            {run.status === 'pending' ? 'No step has started yet.' : 'No steps were recorded.'}
         </p>
      );
   }
   return (
      <ol className="rounded-md border border-border/60 bg-background px-2">
         {steps.map((step) => (
            <StepRow key={step.id} step={step} orgId={orgId} workflowId={run.workflowId} />
         ))}
      </ol>
   );
}

interface LedgerLine {
   id: string;
   at: string;
   text: string;
   type: string;
}

/**
 * The run's own ledger, replayed then followed until the terminal event.
 * The stream ends on its own once the run settles, so there is nothing to
 * reconnect; a dropped connection mid-run is reported in place.
 */
export function WorkflowRunLedger({ runId, className }: { runId: string; className?: string }) {
   const [lines, setLines] = useState<LedgerLine[]>([]);
   const [state, setState] = useState<'listening' | 'ended' | 'interrupted' | string>('listening');

   useEffect(() => {
      const controller = new AbortController();
      const seen = new Set<string>();
      setLines([]);
      setState('listening');
      void (async () => {
         try {
            for await (const event of streamWorkflowRunEvents(runId, {
               signal: controller.signal,
            })) {
               if (seen.has(event.id)) continue;
               seen.add(event.id);
               setLines((current) => [...current, toLine(event)]);
               if (isTerminalWorkflowRunEvent(event.type)) {
                  setState('ended');
                  return;
               }
            }
            if (!controller.signal.aborted) setState('ended');
         } catch (error) {
            if (controller.signal.aborted) return;
            setState(error instanceof BerryApiError ? error.message : 'interrupted');
         }
      })();
      return () => controller.abort();
   }, [runId]);

   return (
      <div className={cn('rounded-md border border-border/60 bg-background', className)}>
         <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
            <span className="font-medium">Ledger</span>
            <span className="text-muted-foreground" role="status">
               {state === 'listening'
                  ? 'listening…'
                  : state === 'ended'
                    ? `${lines.length} event${lines.length === 1 ? '' : 's'}`
                    : state}
            </span>
         </div>
         <ol className="max-h-80 overflow-auto px-3 py-2 font-mono leading-6">
            {lines.length === 0 ? (
               <li className="text-muted-foreground">Waiting for the first event…</li>
            ) : (
               lines.map((line) => (
                  <li key={line.id} className="flex gap-3">
                     <span className="shrink-0 tabular-nums text-muted-foreground">
                        {timeText(line.at)}
                     </span>
                     <span
                        className={cn(
                           'min-w-0 break-words',
                           line.type.endsWith('.failed') && 'text-status-danger',
                           line.type.endsWith('.succeeded') && 'text-status-success',
                           line.type.endsWith('.waiting') && 'text-status-warning'
                        )}
                     >
                        {line.text}
                     </span>
                  </li>
               ))
            )}
         </ol>
      </div>
   );
}

function toLine(event: EventEnvelope): LedgerLine {
   return { id: event.id, at: event.occurredAt, text: describeRunEvent(event), type: event.type };
}
