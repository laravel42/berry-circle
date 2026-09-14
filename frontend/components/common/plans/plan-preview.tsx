'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
   AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { PlanQuestionsWizard } from './plan-questions-wizard';
import { usePlan } from '@/hooks/use-plan';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   describePlanCounts,
   describePlanFailure,
   isPlanGenerating,
   isPlanOpen,
   planCounts,
   startPlanBlocker,
   type PlanRecord,
} from '@/lib/plans';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { usePlanStore } from '@/store/plan-store';
import { useProjectsStore } from '@/store/projects-store';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PlanStatusBadge } from './plan-status-badge';
import { PlanApprovals, PlanAssumptions, PlanConnections, PlanIssues, Pill } from './plan-sections';
import {
   PlanBlockedQuestions,
   PlanFindings,
   PlanGenerationFailure,
   PlanGenerationProgress,
} from './plan-validation';

interface PlanPreviewProps {
   planId: string;
}

function confidenceText(value: number | null | undefined): string | null {
   if (value === null || value === undefined) return null;
   return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}% confidence`;
}

function whenText(iso: string): string {
   try {
      return format(parseISO(iso), 'd MMM yyyy, HH:mm');
   } catch {
      return iso;
   }
}

/** A prompt shortened to a title's length while there is no goal yet. */
function promptTitle(prompt: string | null | undefined): string {
   const text = prompt?.replace(/\s+/g, ' ').trim() ?? '';
   if (!text) return 'New plan';
   return text.length > 90 ? `${text.slice(0, 89)}…` : text;
}

/**
 * The plan a prompt turned into, read-only, with the one decision that
 * matters: Start Plan. Everything the planner proposed is on the page —
 * tasks, approvals, assumptions, the connections it needs and
 * what the validator found — because nothing here exists yet, and the person
 * pressing Start is agreeing to all of it at once.
 */
/**
 * Start a plan whose project is led by the AI workflow, without asking again.
 *
 * Gated on `startPlanBlocker` — the same check the Start button uses — so this
 * can never start something a person would have been stopped from starting:
 * still generating, blocked on questions, or invalid all hold it back until
 * they clear. A high-risk plan still lands in `pendingApproval`, because that
 * is the server's judgement and not this one's.
 *
 * The flag is taken rather than read, so a plan starts at most once however
 * many times a poll re-renders this.
 */
function useAutoStartPlan(record: PlanRecord | undefined) {
   const takeAutoStart = usePlanStore((state) => state.takeAutoStart);
   const startPlan = usePlanStore((state) => state.startPlan);

   useEffect(() => {
      if (!record || startPlanBlocker(record) !== null) return;
      if (!takeAutoStart(record.id)) return;
      void startPlan(record.id)
         .then((next) => {
            if (next.status === 'pendingApproval') {
               toast.info('Sent to an admin for approval');
            } else if (next.compile?.status === 'failed') {
               toast.error('The plan was approved but its tasks could not be created');
            } else {
               toast.success('Tasks generated');
            }
         })
         .catch((error: unknown) => toast.error(describePlanFailure(error)));
   }, [record, takeAutoStart, startPlan]);
}

/**
 * Whether the wizard should show itself, and remembering a dismissal.
 *
 * It opens on its own because a blocked plan is waiting on the person looking
 * at it, and making them find a button first is the gap this feature exists to
 * close. Dismissing it sticks until the plan changes: someone who closed the
 * questions to read the goal first should not have to close them again on
 * every re-render, but a new version is a new set of questions.
 */
function useQuestionsWizard(record: PlanRecord | undefined) {
   const blocked = record?.validation.status === 'blocked';
   const asks = (record?.plan?.assumptions.length ?? 0) > 0;
   const version = record?.version ?? 0;
   const [open, setOpen] = useState(false);
   const [dismissed, setDismissed] = useState<number | null>(null);

   useEffect(() => {
      if (!blocked || !asks) {
         setOpen(false);
         return;
      }
      if (dismissed === version) return;
      setOpen(true);
   }, [blocked, asks, version, dismissed]);

   return {
      open: open && blocked && asks,
      canAnswer: Boolean(blocked && asks),
      setOpen: (next: boolean) => {
         setOpen(next);
         if (!next) setDismissed(version);
      },
   };
}

export default function PlanPreview({ planId }: PlanPreviewProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const inDrawer = useInDetailDrawer();
   const { record, error, busy } = usePlan(planId);
   useAutoStartPlan(record);
   const wizard = useQuestionsWizard(record);

   if (!record) {
      return (
         <div className="p-6 text-muted-foreground" role={error ? 'alert' : 'status'}>
            {error ?? (busy === 'loading' ? 'Loading plan…' : 'Plan not found.')}
         </div>
      );
   }

   const plan = record.plan;
   const generating = isPlanGenerating(record);
   const title = plan?.goal.title ?? promptTitle(record.sourcePrompt);
   const counts = planCounts(plan);
   // A blocked plan is a goal-only skeleton: its confidence is not a
   // judgement of anything, and its blocking assumptions are the questions
   // the panel above already asks.
   const blocked = record.validation.status === 'blocked';
   const confidence = blocked ? null : confidenceText(record.confidence ?? plan?.confidence);

   return (
      <div
         className={cn(
            'h-full min-h-0 w-full overflow-hidden bg-container',
            inDrawer ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]' : 'flex'
         )}
      >
         <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
               <div className="mx-auto max-w-3xl px-6 py-6 sm:px-8 sm:py-8">
                  <h1 className="text-balance font-display leading-[1.08] tracking-[-0.025em]">
                     {title}
                  </h1>
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                     {plan ? (
                        <span>{describePlanCounts(counts)}</span>
                     ) : (
                        <span>{generating ? 'Working out what this needs…' : 'No plan yet.'}</span>
                     )}
                     {confidence && <span>· {confidence}</span>}
                     <span className="lg:hidden">
                        · <PlanStatusBadge record={record} className="align-middle" />
                     </span>
                  </p>

                  <PlanGenerationProgress record={record} />
                  <PlanGenerationFailure record={record} />
                  <PlanBlockedQuestions
                     record={record}
                     onAnswer={wizard.canAnswer ? () => wizard.setOpen(true) : undefined}
                  />
                  <PlanOutcome record={record} orgId={orgId ?? WORKSPACE_SLUG} />
                  <PlanFindings record={record} />

                  {record.sourcePrompt && (
                     <section className="mt-6">
                        <h3 className="font-medium">You asked</h3>
                        <blockquote className="mt-1.5 whitespace-pre-line border-l-2 border-border pl-3 leading-6 text-muted-foreground">
                           {record.sourcePrompt}
                        </blockquote>
                     </section>
                  )}

                  {plan?.goal.description && (
                     <section className="mt-6">
                        <h3 className="font-medium">Goal</h3>
                        <p className="mt-1.5 whitespace-pre-line leading-6">
                           {plan.goal.description}
                        </p>
                     </section>
                  )}

                  {plan && (
                     <>
                        <PlanAssumptions
                           assumptions={
                              blocked
                                 ? plan.assumptions.filter((assumption) => !assumption.blocking)
                                 : plan.assumptions
                           }
                        />
                        <PlanConnections
                           connections={
                              record.validation.requiredConnections.length > 0
                                 ? record.validation.requiredConnections
                                 : plan.requiredConnections
                           }
                           orgId={orgId ?? WORKSPACE_SLUG}
                        />
                        <PlanIssues plan={plan} />
                        <PlanApprovals plan={plan} />
                        {counts.tasks === 0 && counts.approvals === 0 && (
                           <p className="mt-8 text-muted-foreground">
                              Berry found nothing to create for this request.
                           </p>
                        )}
                     </>
                  )}
               </div>
            </div>

            {isPlanOpen(record) && <PlanActions record={record} />}
            <PlanQuestionsWizard record={record} open={wizard.open} onOpenChange={wizard.setOpen} />
         </div>

         <aside className="hidden h-full w-[221px] min-w-0 shrink-0 flex-col overflow-y-auto border-l bg-muted/15 px-5 pt-6 pb-3.5 lg:flex">
            <PlanProperties record={record} />
         </aside>
      </div>
   );
}

/** What pressing Start did, once it has. */
function PlanOutcome({ record, orgId }: { record: PlanRecord; orgId: string }) {
   const issues = useIssuesStore((state) => state.issues);
   const compilePlan = usePlanStore((state) => state.compilePlan);
   const busy = usePlanStore((state) => state.busy[record.id] ?? null);

   if (record.status === 'pendingApproval') {
      return (
         <div
            role="status"
            className="mt-5 flex items-start gap-3 rounded-md border border-border/60 bg-background px-4 py-3"
         >
            <BerryMark size="sm" tone="attention" className="mt-1" />
            <div>
               <p className="font-medium">Sent to an admin for approval</p>
               <p className="text-muted-foreground">
                  This plan is high risk, so an admin decides. Nothing starts until they approve.
               </p>
            </div>
         </div>
      );
   }

   if (record.status !== 'approved' || !record.compile) return null;
   const compile = record.compile;

   if (compile.status === 'failed') {
      return (
         <div
            role="alert"
            className="mt-5 flex items-start gap-3 rounded-md border border-border/60 bg-background px-4 py-3"
         >
            <BerryMark size="sm" tone="danger" className="mt-1" />
            <div className="min-w-0 flex-1">
               <p className="font-medium">The plan was approved but could not be started</p>
               {compile.error && <p className="text-muted-foreground">{compile.error}</p>}
               <Button
                  size="xs"
                  variant="secondary"
                  className="mt-2"
                  disabled={busy === 'compiling'}
                  onClick={() => {
                     void compilePlan(record.id)
                        .then(() => toast.success('Plan started'))
                        .catch((error: unknown) => toast.error(describePlanFailure(error)));
                  }}
               >
                  {busy === 'compiling' ? 'Retrying…' : 'Retry'}
               </Button>
            </div>
         </div>
      );
   }

   if (compile.status === 'running') {
      return (
         <div
            role="status"
            className="mt-5 flex items-center gap-2 rounded-md border border-border/60 bg-background px-4 py-3"
         >
            <BerryMark size="sm" tone="working" pulse />
            <span className="font-medium">Starting the plan…</span>
         </div>
      );
   }

   const created = compile.issueIds
      .map((id) => issues.find((issue) => issue.id === id))
      .filter((issue): issue is NonNullable<typeof issue> => Boolean(issue));

   return (
      <div
         role="status"
         className="mt-5 rounded-md border border-border/60 bg-background px-4 py-3"
      >
         <div className="flex items-center gap-2">
            <BerryMark size="sm" tone="complete" />
            <span className="font-medium">Plan started</span>
            {compile.compiledAt && (
               <span className="text-muted-foreground">· {whenText(compile.compiledAt)}</span>
            )}
         </div>
         <p className="mt-1 text-muted-foreground">
            {describePlanCounts({
               tasks: compile.issueIds.length,
               approvals: compile.approvalIds.length,
            })}{' '}
            created.
         </p>
         {created.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
               {created.map((issue) => (
                  <li key={issue.id}>
                     <Link
                        href={`/${orgId}/issue/${issue.identifier}`}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 hover:bg-accent"
                     >
                        <span className="text-muted-foreground">{issue.identifier}</span>
                        <span className="max-w-64 truncate">{issue.title}</span>
                     </Link>
                  </li>
               ))}
            </ul>
         )}
         <Button asChild size="xs" variant="secondary" className="mt-3">
            <Link href={`/${orgId}/tasks`}>View tasks</Link>
         </Button>
      </div>
   );
}

/** Start Plan and Reject, with the reason Start is disabled when it is. */
function PlanActions({ record }: { record: PlanRecord }) {
   const startPlan = usePlanStore((state) => state.startPlan);
   const rejectPlan = usePlanStore((state) => state.rejectPlan);
   const busy = usePlanStore((state) => state.busy[record.id] ?? null);
   const blocker = startPlanBlocker(record);
   const working = busy === 'starting' || busy === 'rejecting';

   const onStart = () => {
      void startPlan(record.id)
         .then((next) => {
            if (next.status === 'pendingApproval') {
               toast.info('Sent to an admin for approval');
            } else if (next.compile?.status === 'failed') {
               toast.error('The plan was approved but could not be started');
            } else {
               toast.success('Plan started');
            }
         })
         .catch((error: unknown) => toast.error(describePlanFailure(error)));
   };

   const onReject = () => {
      void rejectPlan(record.id)
         .then(() => toast.success('Plan rejected'))
         .catch((error: unknown) => toast.error(describePlanFailure(error)));
   };

   return (
      <div className="relative z-10 shrink-0 border-t border-border/60 bg-container">
         <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3 sm:px-8">
            <p className="min-w-0 flex-1 text-muted-foreground">
               {blocker ?? 'Nothing runs until you press Start Plan.'}
               {!blocker && record.validation.risk === 'high' && (
                  <> This plan is high risk, so an admin may have to approve it first.</>
               )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
               <AlertDialog>
                  <AlertDialogTrigger asChild>
                     <Button variant="ghost" size="sm" disabled={working}>
                        {busy === 'rejecting' ? 'Rejecting…' : 'Reject'}
                     </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                     <AlertDialogHeader>
                        <AlertDialogTitle>Reject this plan?</AlertDialogTitle>
                        <AlertDialogDescription>
                           Nothing was created, so nothing is removed. The draft goal Berry made for
                           it is archived, and you can ask for a new plan any time.
                        </AlertDialogDescription>
                     </AlertDialogHeader>
                     <AlertDialogFooter>
                        <AlertDialogCancel>Keep</AlertDialogCancel>
                        <AlertDialogAction
                           className={buttonVariants({ variant: 'destructive' })}
                           onClick={onReject}
                        >
                           Reject plan
                        </AlertDialogAction>
                     </AlertDialogFooter>
                  </AlertDialogContent>
               </AlertDialog>
               <Button
                  size="sm"
                  disabled={working || blocker !== null}
                  title={blocker ?? undefined}
                  onClick={onStart}
               >
                  {busy === 'starting' ? 'Starting…' : 'Start Plan'}
               </Button>
            </div>
         </div>
      </div>
   );
}

const RISK_TONE = { low: 'neutral', medium: 'attention', high: 'danger' } as const;

/** The record's facts, in the side column. */
function PlanProperties({ record }: { record: PlanRecord }) {
   const projects = useProjectsStore((state) => state.projects);
   const projectId = record.projectId ?? record.plan?.goal.projectId ?? null;
   const project = projectId ? projects.find((candidate) => candidate.id === projectId) : undefined;
   const confidence =
      record.validation.status === 'blocked'
         ? null
         : confidenceText(record.confidence ?? record.plan?.confidence);

   const rows: { label: string; value: ReactNode }[] = [
      { label: 'Status', value: <PlanStatusBadge record={record} /> },
      {
         label: 'Risk',
         value: <Pill tone={RISK_TONE[record.validation.risk]}>{record.validation.risk}</Pill>,
      },
      { label: 'Confidence', value: confidence ?? '—' },
      { label: 'Version', value: record.version > 0 ? `v${record.version}` : '—' },
      { label: 'Planner', value: record.plannerVersion ?? '—' },
      { label: 'Project', value: project?.name ?? (projectId ? 'Unknown project' : 'None') },
      { label: 'Created', value: whenText(record.createdAt) },
   ];

   return (
      <dl className="space-y-3">
         {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5">
               <dt className="text-muted-foreground">{row.label}</dt>
               <dd className="min-w-0 break-words">{row.value}</dd>
            </div>
         ))}
      </dl>
   );
}
