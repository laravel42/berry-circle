'use client';

import { Pill, SectionHeading } from '@/components/common/plans/plan-sections';
import { Button } from '@/components/ui/button';
import { useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { useWorkflow } from '@/hooks/use-workflow';
import { WORKFLOW_RUN_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import { findTool } from '@/lib/integrations';
import { describePlanStep, orderPlanSteps, type FieldError } from '@/lib/plans';
import { describeCron } from '@/lib/cron';
import { describeWorkflowEvent, isWorkflowEditable, type Workflow } from '@/lib/workflows';
import { cn } from '@/lib/utils';
import { useAgentsStore } from '@/store/agents-store';
import { useGoalsStore } from '@/store/goals-store';
import { useMembersStore } from '@/store/members-store';
import { useProvidersStore } from '@/store/providers-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { BerryMark } from '@/components/brand/berry-mark';
import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { WebhookTriggerNotes } from './webhook-trigger-notes';
import { WorkflowStatusBadge } from './workflow-status-badge';
import { WorkflowTriggerLabel } from './workflow-trigger-label';

function whenText(iso: string | null | undefined): string {
   if (!iso) return '—';
   try {
      return format(parseISO(iso), 'd MMM yyyy, HH:mm');
   } catch {
      return iso;
   }
}

const RISK_TONE = { low: 'neutral', medium: 'attention', high: 'danger' } as const;

/** The validator's findings on the stored definition, errors first. */
function Findings({ workflow }: { workflow: Workflow }) {
   const findings: (FieldError & { kind: 'error' | 'warning' })[] = [
      ...workflow.validation.errors.map((entry) => ({ ...entry, kind: 'error' as const })),
      ...workflow.validation.warnings.map((entry) => ({ ...entry, kind: 'warning' as const })),
   ];
   if (findings.length === 0) return null;
   return (
      <section className="mt-6">
         <SectionHeading title="Things to fix" count={findings.length} />
         <ul className="mt-2 space-y-1.5">
            {findings.map((finding, index) => (
               <li
                  key={`${finding.path}-${finding.code}-${index}`}
                  role={finding.kind === 'error' ? 'alert' : 'status'}
                  className="flex items-start gap-2"
               >
                  <BerryMark
                     size="sm"
                     tone={finding.kind === 'error' ? 'danger' : 'attention'}
                     state="hollow"
                     className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                     <p className="leading-6">{finding.message}</p>
                     <p className="text-muted-foreground">
                        {finding.path.replace(/^\/definition\//, '')}
                        {finding.hint && ` · ${finding.hint}`}
                     </p>
                  </div>
               </li>
            ))}
         </ul>
      </section>
   );
}

/** The provider and event an integration trigger listens for, and whether it can hear it. */
function IntegrationTriggerNote({ workflow }: { workflow: Workflow }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const trigger = workflow.definition.trigger;
   const provider = useProvidersStore((state) =>
      state.providers.find((candidate) => candidate.id === trigger.provider)
   );
   const tool = provider
      ? findTool([provider], provider.id, trigger.operation ?? '')?.tool
      : undefined;
   const connection = workflow.requiredConnections.find(
      (candidate) => candidate.provider === trigger.provider
   );
   const connected = provider
      ? provider.connected || provider.id === 'berry'
      : connection?.connected;
   return (
      <div className="mt-1 text-muted-foreground">
         <p>
            {provider?.name ?? trigger.provider} publishes{' '}
            <code className="font-mono">{trigger.operation}</code>
            {tool?.description && ` — ${tool.description}`} The delivery is{' '}
            <code className="font-mono">trigger.payload</code>.
         </p>
         {connected === false && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-status-warning">
               <BerryMark size="sm" tone="attention" state="hollow" />
               {provider?.name ?? trigger.provider} is not connected, so no delivery can reach this
               workflow.
               <Button asChild size="xs" variant="secondary">
                  <Link
                     href={`/${orgId}/settings/integrations?provider=${encodeURIComponent(trigger.provider ?? '')}`}
                  >
                     Connect
                  </Link>
               </Button>
            </p>
         )}
      </div>
   );
}

/** The steps in reading order, with what each reaches outside Berry. */
function Steps({ workflow }: { workflow: Workflow }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const agents = useAgentsStore((state) => state.agents);
   const providers = useProvidersStore((state) => state.providers);
   const workflows = useWorkflowsStore((state) => state.workflows);
   const steps = orderPlanSteps(workflow.definition);
   return (
      <section className="mt-8">
         <div className="flex items-center justify-between gap-3">
            <SectionHeading title="Steps" count={steps.length} />
            <Link
               href={`/${orgId}/workflow/${workflow.id}/canvas`}
               className="text-muted-foreground underline-offset-2 hover:underline"
            >
               {isWorkflowEditable(workflow) ? 'Edit on canvas' : 'View on canvas'}
            </Link>
         </div>
         <ol className="mt-2 rounded-md border border-border/60 bg-background px-4 py-2">
            {steps.map((step, index) => {
               const summary = describePlanStep(step);
               const agentName =
                  step.type === 'agent' && step.agentId
                     ? agents.find((candidate) => candidate.id === step.agentId)?.name
                     : step.type === 'create_issue' && step.assignAgentId
                       ? agents.find((candidate) => candidate.id === step.assignAgentId)?.name
                       : undefined;
               const tool =
                  step.type === 'action'
                     ? findTool(providers, step.provider, step.operation)?.tool
                     : undefined;
               const destructive = tool?.effect === 'destructive';
               const needsApproval = summary.approval || Boolean(tool?.requiresApproval);
               const target =
                  step.type === 'subworkflow'
                     ? workflows.find((candidate) => candidate.id === step.workflowId)
                     : undefined;
               return (
                  <li key={step.id} className="flex items-start gap-3 py-2">
                     <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">
                        {index + 1}
                     </span>
                     <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                           <span className="font-medium">{summary.label}</span>
                           <span className="text-muted-foreground">{step.id}</span>
                           {agentName && <Pill>{agentName}</Pill>}
                           {destructive ? (
                              <Pill tone="danger">destructive</Pill>
                           ) : summary.external ? (
                              <Pill tone="attention">external</Pill>
                           ) : null}
                           {needsApproval && <Pill tone="attention">approval</Pill>}
                           {step.dependsOn.length > 0 && (
                              <span className="text-muted-foreground">
                                 after {step.dependsOn.join(', ')}
                              </span>
                           )}
                        </div>
                        {step.type === 'subworkflow' ? (
                           <p className="mt-0.5 break-words text-muted-foreground">
                              {target ? (
                                 <Link
                                    href={`/${orgId}/workflow/${target.id}/overview`}
                                    className="underline-offset-2 hover:underline"
                                 >
                                    {target.name}
                                 </Link>
                              ) : (
                                 summary.text
                              )}
                              {target && target.status !== 'active' && (
                                 <span className="text-status-warning"> · {target.status}</span>
                              )}
                           </p>
                        ) : (
                           summary.text && (
                              <p className="mt-0.5 break-words text-muted-foreground">
                                 {summary.text}
                              </p>
                           )
                        )}
                     </div>
                  </li>
               );
            })}
            {steps.length === 0 && <li className="py-2 text-muted-foreground">No steps.</li>}
         </ol>
      </section>
   );
}

function Properties({ workflow }: { workflow: Workflow }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const goal = useGoalsStore((state) =>
      workflow.goalId
         ? state.goals.find((candidate) => candidate.id === workflow.goalId)
         : undefined
   );
   const creator = useMembersStore((state) =>
      workflow.createdBy
         ? state.members.find((member) => member.id === workflow.createdBy?.id)
         : undefined
   );
   const missing = workflow.requiredConnections.filter((connection) => !connection.connected);
   const lastRun = workflow.lastRun
      ? statusLook(WORKFLOW_RUN_STATUS, workflow.lastRun.status)
      : null;

   const rows: { label: string; value: ReactNode }[] = [
      { label: 'Status', value: <WorkflowStatusBadge status={workflow.status} /> },
      {
         label: 'Trigger',
         value: <WorkflowTriggerLabel trigger={workflow.trigger} className="max-w-full" />,
      },
      { label: 'Risk', value: <Pill tone={RISK_TONE[workflow.risk]}>{workflow.risk}</Pill> },
      { label: 'Engine', value: workflow.engine },
      { label: 'Version', value: `v${workflow.version} · revision ${workflow.revision}` },
      {
         label: 'Goal',
         value: workflow.goalId ? (
            <Link
               href={`/${orgId}/goal/${workflow.goalId}/overview`}
               className="underline-offset-2 hover:underline"
            >
               {goal?.title ?? 'Open goal'}
            </Link>
         ) : (
            'None'
         ),
      },
      { label: 'Created by', value: creator?.name ?? (workflow.createdBy ? 'a member' : '—') },
      { label: 'Created', value: whenText(workflow.createdAt) },
      { label: 'Last edited', value: whenText(workflow.updatedAt) },
   ];

   return (
      <div className="space-y-5">
         <dl className="space-y-3">
            {rows.map((row) => (
               <div key={row.label} className="flex flex-col gap-0.5">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="min-w-0 break-words">{row.value}</dd>
               </div>
            ))}
         </dl>

         <div>
            <div className="flex items-center justify-between gap-2">
               <span className="text-muted-foreground">Connections</span>
               {missing.length > 0 && (
                  <Button asChild size="xs" variant="secondary">
                     <Link
                        href={`/${orgId}/settings/integrations?provider=${encodeURIComponent(missing[0].provider)}`}
                     >
                        Connect
                     </Link>
                  </Button>
               )}
            </div>
            {workflow.requiredConnections.length === 0 ? (
               <p className="mt-1">None needed</p>
            ) : (
               <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {workflow.requiredConnections.map((connection) => (
                     <li
                        key={connection.provider}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1"
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
            )}
         </div>

         <div>
            <span className="text-muted-foreground">Runs</span>
            <p className="mt-1">
               {workflow.runCounts.total} total · {workflow.runCounts.succeeded} succeeded ·{' '}
               <span className={cn(workflow.runCounts.failed > 0 && 'text-status-danger')}>
                  {workflow.runCounts.failed} failed
               </span>
            </p>
            {workflow.lastRun && lastRun && (
               <Link
                  href={`/${orgId}/workflow/${workflow.id}/run/${workflow.lastRun.id}`}
                  className="mt-1 inline-flex items-center gap-1.5 underline-offset-2 hover:underline"
               >
                  <BerryMark
                     size="sm"
                     tone={lastRun.tone}
                     state={lastRun.state}
                     pulse={lastRun.pulse}
                  />
                  last run {lastRun.label.toLowerCase()} · {whenText(workflow.lastRun.createdAt)}
               </Link>
            )}
            <Link
               href={`/${orgId}/workflow/${workflow.id}/history`}
               className="mt-1 block text-muted-foreground underline-offset-2 hover:underline"
            >
               View history
            </Link>
         </div>
      </div>
   );
}

/**
 * A workflow at a glance: what starts it, what it does, and what it needs.
 * The definition is read-only here; the canvas tab edits it.
 */
export default function WorkflowOverview({ workflowId }: { workflowId: string }) {
   const inDrawer = useInDetailDrawer();
   const { workflow, error, loading } = useWorkflow(workflowId);

   if (!workflow) {
      return (
         <div className="p-6 text-muted-foreground" role={error ? 'alert' : 'status'}>
            {error ?? (loading ? 'Loading workflow…' : 'Workflow not found.')}
         </div>
      );
   }

   const trigger = workflow.definition.trigger;

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
                     {workflow.name}
                  </h1>
                  <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
                     <WorkflowTriggerLabel trigger={workflow.trigger} />
                     <span>· v{workflow.version}</span>
                     <span className="lg:hidden">
                        · <WorkflowStatusBadge status={workflow.status} className="align-middle" />
                     </span>
                  </p>

                  {workflow.description && (
                     <p className="mt-4 whitespace-pre-line leading-6">{workflow.description}</p>
                  )}

                  {workflow.status === 'draft' && (
                     <p className="mt-4 rounded-md border border-border/60 bg-background px-4 py-3 text-muted-foreground">
                        A draft never runs. Activate it when the steps are right; a manual trigger
                        then runs from the header, and a Berry event, schedule, integration event or
                        webhook fires on its own.
                     </p>
                  )}

                  <Findings workflow={workflow} />

                  <section className="mt-8">
                     <SectionHeading title="Trigger" />
                     <div className="mt-2 rounded-md border border-border/60 bg-background px-4 py-3">
                        <WorkflowTriggerLabel trigger={workflow.trigger} className="font-medium" />
                        {trigger.type === 'berry_event' && trigger.event && (
                           <p className="mt-1 text-muted-foreground">
                              topic <code className="font-mono">{trigger.event}</code> ·{' '}
                              {describeWorkflowEvent(trigger.event)}
                           </p>
                        )}
                        {trigger.type === 'manual' && (
                           <p className="mt-1 text-muted-foreground">
                              Only Run now starts it. Whatever you pass becomes{' '}
                              <code className="font-mono">trigger.input</code>.
                           </p>
                        )}
                        {trigger.type === 'schedule' && (
                           <p className="mt-1 text-muted-foreground">
                              {describeCron(trigger.config?.cron ?? '')} · cron{' '}
                              <code className="font-mono">{trigger.config?.cron}</code> ·{' '}
                              {trigger.config?.timezone}
                              {workflow.status === 'active'
                                 ? '. Fires on that clock while active; an instant missed for over an hour is skipped.'
                                 : '. Fires only while the workflow is active.'}
                           </p>
                        )}
                        {trigger.type === 'integration' && (
                           <IntegrationTriggerNote workflow={workflow} />
                        )}
                        {trigger.type === 'webhook' && (
                           <WebhookTriggerNotes workflowId={workflow.id} className="mt-3" />
                        )}
                     </div>
                  </section>

                  <Steps workflow={workflow} />
               </div>
            </div>
         </div>

         <aside className="hidden h-full w-[221px] min-w-0 shrink-0 flex-col overflow-y-auto border-l bg-muted/15 px-5 pt-6 pb-3.5 lg:flex">
            <Properties workflow={workflow} />
         </aside>
      </div>
   );
}
