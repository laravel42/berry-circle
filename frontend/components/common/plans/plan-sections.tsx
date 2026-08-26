'use client';

import { BerryMark, type BerryMarkTone } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { uiPriorityFromApi } from '@/lib/catalog';
import {
   describeApprover,
   describePlanStep,
   describePlanTrigger,
   orderPlanSteps,
   type Plan,
   type PlanAssumption,
   type RequiredConnection,
} from '@/lib/plans';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useMembersStore } from '@/store/members-store';
import { Workflow, Zap } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

type PillTone = 'neutral' | 'attention' | 'danger' | 'complete' | 'review';

const PILL_TONE: Record<PillTone, string> = {
   neutral: 'text-muted-foreground',
   attention: 'text-status-warning',
   danger: 'text-status-danger',
   complete: 'text-status-success',
   review: 'text-review-pending',
};

/** A small inline label; the tone colours the text only. */
export function Pill({
   tone = 'neutral',
   className,
   children,
}: {
   tone?: PillTone;
   className?: string;
   children: ReactNode;
}) {
   return (
      <span
         className={cn(
            'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border/60 bg-muted/40 px-1.5 leading-5',
            PILL_TONE[tone],
            className
         )}
      >
         {children}
      </span>
   );
}

export function SectionHeading({ title, count }: { title: string; count?: number }) {
   return (
      <h3 className="font-medium">
         {title}
         {count !== undefined && <span className="ml-1.5 text-muted-foreground">· {count}</span>}
      </h3>
   );
}

const CONFIDENCE_TONE: Record<PlanAssumption['confidence'], BerryMarkTone> = {
   high: 'complete',
   medium: 'neutral',
   low: 'attention',
};

/** What the planner decided without being told. Read-only until P6 makes rows editable. */
export function PlanAssumptions({ assumptions }: { assumptions: PlanAssumption[] }) {
   if (assumptions.length === 0) return null;
   return (
      <section className="mt-6">
         <SectionHeading title="Assumptions" count={assumptions.length} />
         <ul className="mt-2 space-y-1.5">
            {assumptions.map((assumption) => (
               <li key={assumption.id} className="flex items-start gap-2">
                  <BerryMark
                     size="sm"
                     tone={
                        assumption.blocking ? 'attention' : CONFIDENCE_TONE[assumption.confidence]
                     }
                     state={assumption.blocking ? 'hollow' : 'solid'}
                     className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                     <p className="leading-6">{assumption.description}</p>
                     <p className="text-muted-foreground">
                        {assumption.blocking
                           ? 'needs an answer'
                           : `${assumption.confidence} confidence`}
                     </p>
                  </div>
               </li>
            ))}
         </ul>
      </section>
   );
}

/** Providers the plan needs connected, with the way to connect them. */
export function PlanConnections({
   connections,
   orgId,
}: {
   connections: RequiredConnection[];
   orgId: string;
}) {
   if (connections.length === 0) return null;
   const missing = connections.some((connection) => !connection.connected);
   return (
      <section className="mt-6">
         <div className="flex items-center justify-between gap-3">
            <SectionHeading title="Connections" count={connections.length} />
            {missing && (
               <Button asChild size="xs" variant="secondary">
                  <Link href={`/${orgId}/settings/integrations`}>Connect</Link>
               </Button>
            )}
         </div>
         <ul className="mt-2 flex flex-wrap gap-1.5">
            {connections.map((connection) => (
               <li
                  key={connection.provider}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1"
                  title={connection.purpose}
               >
                  <BerryMark
                     size="sm"
                     tone={connection.connected ? 'complete' : 'attention'}
                     state={connection.connected ? 'solid' : 'hollow'}
                  />
                  <span className="font-medium">{connection.provider}</span>
                  <span className="text-muted-foreground">
                     {connection.connected ? 'connected' : 'not connected'}
                  </span>
               </li>
            ))}
         </ul>
         {missing && (
            <p className="mt-2 text-muted-foreground">
               The plan can start without them; workflows that need them stay drafts until they are
               connected.
            </p>
         )}
      </section>
   );
}

/** The finite work: one row per task the plan would create. */
export function PlanIssues({ plan }: { plan: Plan }) {
   const agents = useAgentsStore((state) => state.agents);
   if (plan.issues.length === 0) return null;
   const titleOf = new Map(plan.issues.map((issue) => [issue.tempId, issue.title]));
   return (
      <section className="mt-8">
         <SectionHeading title="Work" count={plan.issues.length} />
         <ul className="mt-2 space-y-2">
            {plan.issues.map((issue) => {
               const priority = uiPriorityFromApi(issue.priority ?? 'none');
               const PriorityIcon = priority?.icon;
               const agent = issue.suggestedAgentId
                  ? agents.find((candidate) => candidate.id === issue.suggestedAgentId)
                  : undefined;
               return (
                  <li
                     key={issue.tempId}
                     className="flex items-start gap-3 rounded-md border border-border/60 bg-background px-3 py-2.5"
                  >
                     {PriorityIcon && (
                        <span
                           className="mt-1 inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground"
                           title={priority?.name}
                        >
                           <PriorityIcon className="size-4" />
                        </span>
                     )}
                     <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                           <span className="font-medium">{issue.title}</span>
                           {issue.requiresReview && <Pill tone="review">review</Pill>}
                           {issue.requiresApproval && <Pill tone="attention">approval</Pill>}
                        </div>
                        {issue.description && (
                           <p className="mt-1 whitespace-pre-line text-muted-foreground">
                              {issue.description}
                           </p>
                        )}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                           <span>
                              {agent
                                 ? `agent · ${agent.name}`
                                 : issue.suggestedAgentId
                                   ? 'agent · unknown'
                                   : 'agent · by capability'}
                           </span>
                           {issue.requiredCapabilities.map((capability) => (
                              <Pill key={capability}>{capability}</Pill>
                           ))}
                           {issue.dependsOn.length > 0 && (
                              <span>
                                 after{' '}
                                 {issue.dependsOn
                                    .map((tempId) => titleOf.get(tempId) ?? tempId)
                                    .join(', ')}
                              </span>
                           )}
                           {issue.estimate && <span>{issue.estimate}</span>}
                        </div>
                     </div>
                  </li>
               );
            })}
         </ul>
      </section>
   );
}

/** The repeatable processes: trigger then steps, one card per workflow. */
export function PlanWorkflows({ plan }: { plan: Plan }) {
   const agents = useAgentsStore((state) => state.agents);
   if (plan.workflows.length === 0) return null;
   return (
      <section className="mt-8">
         <SectionHeading title="Automation" count={plan.workflows.length} />
         <ul className="mt-2 space-y-3">
            {plan.workflows.map((workflow) => {
               const steps = orderPlanSteps(workflow);
               return (
                  <li
                     key={workflow.tempId}
                     className="rounded-md border border-border/60 bg-background"
                  >
                     <div className="border-b border-border/60 px-4 py-3">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                           <Workflow className="size-4 shrink-0 text-muted-foreground" />
                           <span className="font-medium">{workflow.name}</span>
                           <Pill tone={workflow.activateOnApprove ? 'complete' : 'neutral'}>
                              {workflow.activateOnApprove ? 'activates on start' : 'draft'}
                           </Pill>
                        </div>
                        {workflow.description && (
                           <p className="mt-1 text-muted-foreground">{workflow.description}</p>
                        )}
                        <p className="mt-1.5 flex items-center gap-1.5">
                           <Zap className="size-3.5 shrink-0 text-muted-foreground" />
                           {describePlanTrigger(workflow.trigger)}
                        </p>
                     </div>
                     <ol className="px-4 py-2">
                        {steps.map((step, index) => {
                           const summary = describePlanStep(step);
                           const agentName =
                              step.type === 'agent' && step.agentId
                                 ? agents.find((candidate) => candidate.id === step.agentId)?.name
                                 : undefined;
                           return (
                              <li key={step.id} className="flex items-start gap-3 py-1.5">
                                 <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                                    {index + 1}
                                 </span>
                                 <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                       <span className="font-medium">{summary.label}</span>
                                       {agentName && <Pill>{agentName}</Pill>}
                                       {summary.external && <Pill tone="attention">external</Pill>}
                                       {summary.approval && <Pill tone="attention">approval</Pill>}
                                       {step.dependsOn.length > 0 && (
                                          <span className="text-muted-foreground">
                                             after {step.dependsOn.join(', ')}
                                          </span>
                                       )}
                                    </div>
                                    {summary.text && (
                                       <p className="mt-0.5 break-words text-muted-foreground">
                                          {summary.text}
                                       </p>
                                    )}
                                 </div>
                              </li>
                           );
                        })}
                        {steps.length === 0 && (
                           <li className="py-1.5 text-muted-foreground">No steps.</li>
                        )}
                     </ol>
                  </li>
               );
            })}
         </ul>
      </section>
   );
}

/** The human decisions the plan asks for before something runs. */
export function PlanApprovals({ plan }: { plan: Plan }) {
   const members = useMembersStore((state) => state.members);
   if (plan.approvals.length === 0) return null;
   const targetName = (kind: string, tempId: string, stepId?: string | null) => {
      if (kind === 'issue') {
         const issue = plan.issues.find((candidate) => candidate.tempId === tempId);
         return `task "${issue?.title ?? tempId}"`;
      }
      const workflow = plan.workflows.find((candidate) => candidate.tempId === tempId);
      const name = workflow?.name ?? tempId;
      return kind === 'step' ? `step ${stepId ?? '?'} of "${name}"` : `workflow "${name}"`;
   };
   return (
      <section className="mt-8">
         <SectionHeading title="Approvals" count={plan.approvals.length} />
         <ul className="mt-2 space-y-2">
            {plan.approvals.map((approval) => {
               const approver =
                  approval.approver.type === 'user' && approval.approver.userId
                     ? (members.find((member) => member.id === approval.approver.userId)?.name ??
                       describeApprover(approval.approver))
                     : describeApprover(approval.approver);
               return (
                  <li
                     key={approval.tempId}
                     className="flex items-start gap-3 rounded-md border border-border/60 bg-background px-3 py-2.5"
                  >
                     <BerryMark size="sm" tone="attention" className="mt-1" />
                     <div className="min-w-0 flex-1">
                        <span className="font-medium">{approval.title}</span>
                        {approval.description && (
                           <p className="mt-1 text-muted-foreground">{approval.description}</p>
                        )}
                        <p className="mt-1 text-muted-foreground">
                           gates{' '}
                           {targetName(
                              approval.target.kind,
                              approval.target.tempId,
                              approval.target.stepId
                           )}
                           {' · '}
                           {approver}
                           {' · '}
                           {approval.reason.replace('_', ' ')}
                           {approval.timeout && ` · expires after ${approval.timeout}`}
                        </p>
                     </div>
                  </li>
               );
            })}
         </ul>
      </section>
   );
}
