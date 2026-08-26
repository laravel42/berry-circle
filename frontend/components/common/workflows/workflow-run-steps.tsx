'use client';

import { Pill } from '@/components/common/plans/plan-sections';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   childRunOf,
   describeRunEvent,
   describeStepType,
   describeWorkflowRunDuration,
   isTerminalWorkflowRunEvent,
   shortRunId,
   splitStepRunId,
   streamWorkflowRunEvents,
   type WorkflowRun,
   type WorkflowStepRun,
} from '@/lib/workflow-runs';
import { stringList } from '@/lib/workflow-definition';
import type { EventEnvelope } from '@/lib/events';
import { BerryApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { format, parseISO } from 'date-fns';
import { Repeat } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { GROUP_TONE, nodeKind } from './canvas/nodes/node-kinds';
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

function payloadNumber(value: unknown, key: string): number | null {
   if (typeof value !== 'object' || value === null) return null;
   const found = (value as Record<string, unknown>)[key];
   return typeof found === 'number' ? found : null;
}

function StepRow({
   step,
   orgId,
   iteration = false,
}: {
   step: WorkflowStepRun;
   orgId: string;
   /** One pass of a loop body: the index is the row's name. */
   iteration?: boolean;
}) {
   const issue = useIssuesStore((state) =>
      step.issueId ? state.issues.find((candidate) => candidate.id === step.issueId) : undefined
   );
   const child = childRunOf(step);
   const childWorkflow = useWorkflowsStore((state) =>
      child ? state.workflows.find((candidate) => candidate.id === child.workflowId) : undefined
   );
   const duration = describeWorkflowRunDuration(step);
   const hasDetail =
      pretty(step.input) !== null || pretty(step.output) !== null || step.failure !== null;
   const { base, index } = splitStepRunId(step.stepId);
   const kind = nodeKind(step.stepType);
   const Icon = kind.icon;
   const links: { href: string; label: string }[] = [];
   if (step.issueId) {
      links.push({
         href: issue ? `/${orgId}/issue/${issue.identifier}` : `/${orgId}/issue/${step.issueId}`,
         label: issue ? `${issue.identifier} ${issue.title}` : 'task',
      });
   }
   if (child) {
      links.push({
         href: `/${orgId}/workflow/${child.workflowId}/run/${child.runId}`,
         label: `child run ${shortRunId(child.runId)}${childWorkflow ? ` · ${childWorkflow.name}` : ''}`,
      });
   } else if (step.runId) {
      links.push({ href: `/${orgId}/runs?run=${step.runId}`, label: 'agent run' });
   }
   if (step.approvalId) {
      links.push({ href: `/${orgId}/approvals?approval=${step.approvalId}`, label: 'approval' });
   }
   const count = step.stepType === 'foreach' ? payloadNumber(step.output, 'count') : null;

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
                     {iteration ? (
                        <span className="font-mono">
                           {base}
                           <span className="text-muted-foreground">[{index}]</span>
                        </span>
                     ) : (
                        <>
                           <Icon
                              className={cn('size-3.5 shrink-0', GROUP_TONE[kind.group])}
                              aria-hidden
                           />
                           <span className="font-medium">{describeStepType(step.stepType)}</span>
                           <span className="text-muted-foreground">{step.stepId}</span>
                        </>
                     )}
                     {step.attempt > 1 && <Pill>attempt {step.attempt}</Pill>}
                     {count !== null && (
                        <Pill>
                           {count} item{count === 1 ? '' : 's'}
                        </Pill>
                     )}
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

type StepGroup =
   | { kind: 'step'; step: WorkflowStepRun }
   | { kind: 'loop'; base: string; stepType: string; iterations: WorkflowStepRun[] };

/**
 * The rows in the order they ran, with every pass of a loop body (`note[0]`,
 * `note[1]`, …) gathered under the body step it belongs to. A group sits
 * where its first pass was recorded, which is right after its loop began.
 */
export function groupStepRuns(steps: WorkflowStepRun[]): StepGroup[] {
   const rows: StepGroup[] = [];
   const groups = new Map<string, Extract<StepGroup, { kind: 'loop' }>>();
   for (const step of steps) {
      const { base, index } = splitStepRunId(step.stepId);
      if (index === null) {
         rows.push({ kind: 'step', step });
         continue;
      }
      let group = groups.get(base);
      if (!group) {
         group = { kind: 'loop', base, stepType: step.stepType, iterations: [] };
         groups.set(base, group);
         rows.push(group);
      }
      group.iterations.push(step);
   }
   return rows;
}

/** The passes of one loop body, with the loop they belong to when the definition says. */
function LoopBodyRows({
   group,
   orgId,
   loopId,
}: {
   group: Extract<StepGroup, { kind: 'loop' }>;
   orgId: string;
   loopId: string | null;
}) {
   const kind = nodeKind(group.stepType);
   const Icon = kind.icon;
   const failed = group.iterations.filter((step) => step.status === 'failed').length;
   const done = group.iterations.filter((step) => step.status === 'succeeded').length;
   const open = group.iterations.length <= 10;
   return (
      <li className="border-b border-border/60 last:border-b-0">
         <details open={open || failed > 0}>
            <summary className="flex cursor-pointer list-none items-start gap-3 px-1 py-2.5 hover:bg-accent/40">
               <Repeat className="mt-1 size-3.5 shrink-0 text-status-info" aria-hidden />
               <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                     <Icon
                        className={cn('size-3.5 shrink-0', GROUP_TONE[kind.group])}
                        aria-hidden
                     />
                     <span className="font-medium">{describeStepType(group.stepType)}</span>
                     <span className="text-muted-foreground">{group.base}</span>
                     <Pill>
                        {group.iterations.length} pass{group.iterations.length === 1 ? '' : 'es'}
                     </Pill>
                     {loopId && <span className="text-muted-foreground">in loop {loopId}</span>}
                     {failed > 0 && <Pill tone="danger">{failed} failed</Pill>}
                  </div>
                  <p className="mt-0.5 text-muted-foreground">
                     {done} of {group.iterations.length} succeeded
                  </p>
               </div>
            </summary>
            <ol className="ml-4 border-l border-dashed border-border/60 pl-3">
               {group.iterations.map((step) => (
                  <StepRow key={step.id} step={step} orgId={orgId} iteration />
               ))}
            </ol>
         </details>
      </li>
   );
}

/** The step attempts of one run, in the order they ran, each openable to its payloads. */
export function WorkflowRunSteps({ run }: { run: WorkflowRun }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const workflow = useWorkflowsStore((state) =>
      state.workflows.find((candidate) => candidate.id === run.workflowId)
   );
   const steps = run.steps ?? [];
   if (steps.length === 0) {
      return (
         <p className="text-muted-foreground">
            {run.status === 'pending' ? 'No step has started yet.' : 'No steps were recorded.'}
         </p>
      );
   }
   const loopOf = (bodyId: string): string | null => {
      const loop = workflow?.definitionSource.steps.find(
         (step) => step.type === 'foreach' && stringList(step.steps).includes(bodyId)
      );
      return loop?.id ?? null;
   };
   return (
      <ol className="rounded-md border border-border/60 bg-background px-2">
         {groupStepRuns(steps).map((row) =>
            row.kind === 'step' ? (
               <StepRow key={row.step.id} step={row.step} orgId={orgId} />
            ) : (
               <LoopBodyRows
                  key={`loop:${row.base}`}
                  group={row}
                  orgId={orgId}
                  loopId={loopOf(row.base)}
               />
            )
         )}
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
