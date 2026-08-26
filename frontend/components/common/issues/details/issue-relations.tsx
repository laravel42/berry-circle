'use client';

import { ApprovalCard } from '@/components/common/approvals/approval-card';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Issue, IssueDependencyRef } from '@/data/issues';
import { isApprovalPending } from '@/lib/approvals';
import { GOAL_STATUS, statusLook, uiStatusFromApi } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   addIssueDependency,
   describeDependencyFailure,
   describePatchFailure,
   listIssueDependencies,
   removeIssueDependency,
   setIssueGoal,
   type IssueDependencyLists,
} from '@/lib/issues';
import { useApprovalsStore } from '@/store/approvals-store';
import { useGoalsStore } from '@/store/goals-store';
import { useIssuesStore } from '@/store/issues-store';
import { useWorkflowsStore } from '@/store/workflows-store';
import { BerryMark } from '@/components/brand/berry-mark';
import { Ban, CheckIcon, Plus, Target, Workflow, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Section } from './panel-section';

function useOrgId(): string {
   const params = useParams<{ orgId?: string }>();
   return params?.orgId || WORKSPACE_SLUG;
}

/** The goal a task serves, with a picker to change or clear it. */
export function IssueGoalSection({ issue }: { issue: Issue }) {
   const orgId = useOrgId();
   const goals = useGoalsStore((state) => state.goals);
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [open, setOpen] = useState(false);
   const [busy, setBusy] = useState(false);
   const current = issue.goal ?? null;
   const known = current ? goals.find((goal) => goal.id === current.id) : undefined;

   const choose = async (goalId: string | null) => {
      setOpen(false);
      if ((goalId ?? null) === (current?.id ?? null)) return;
      const next = goalId ? goals.find((goal) => goal.id === goalId) : undefined;
      const previous = issue.goal;
      updateIssue(issue.id, { goal: next ? { id: next.id, title: next.title } : null });
      setBusy(true);
      try {
         await setIssueGoal(issue.id, goalId);
      } catch (error) {
         updateIssue(issue.id, { goal: previous });
         toast.error(describePatchFailure(error));
      } finally {
         setBusy(false);
      }
   };

   const picker = (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               variant="ghost"
               size="xs"
               className="h-6 px-1.5 text-muted-foreground"
               disabled={busy}
               aria-label={current ? 'Change goal' : 'Link a goal'}
            >
               {current ? 'Change' : 'Link'}
            </Button>
         </PopoverTrigger>
         <PopoverContent className="w-72 p-0" align="end">
            <Command>
               <CommandInput placeholder="Search goals…" />
               <CommandList>
                  <CommandEmpty>No goal matches.</CommandEmpty>
                  <CommandGroup>
                     {current && (
                        <CommandItem value="__none__" onSelect={() => void choose(null)}>
                           <X className="size-3.5 text-muted-foreground" />
                           No goal
                        </CommandItem>
                     )}
                     {goals.map((goal) => {
                        const look = statusLook(GOAL_STATUS, goal.status);
                        return (
                           <CommandItem
                              key={goal.id}
                              value={`${goal.title} ${goal.id}`}
                              onSelect={() => void choose(goal.id)}
                              className="flex items-center gap-2"
                           >
                              <BerryMark size="sm" tone={look.tone} state={look.state} />
                              <span className="min-w-0 flex-1 truncate">{goal.title}</span>
                              {current?.id === goal.id && <CheckIcon className="size-4" />}
                           </CommandItem>
                        );
                     })}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );

   return (
      <Section title="Goal" action={picker}>
         {current ? (
            <Link
               href={`/${orgId}/goal/${current.id}/overview`}
               className="-mx-1.5 flex min-w-0 items-center gap-2 rounded px-1.5 py-1 hover:bg-sidebar/50"
            >
               {known ? (
                  <BerryMark
                     size="sm"
                     tone={statusLook(GOAL_STATUS, known.status).tone}
                     state={statusLook(GOAL_STATUS, known.status).state}
                  />
               ) : (
                  <Target className="size-3.5 shrink-0 text-muted-foreground" />
               )}
               <span className="truncate">{known?.title ?? current.title}</span>
            </Link>
         ) : (
            <p className="text-muted-foreground">Serves no goal.</p>
         )}
      </Section>
   );
}

/** "Created by workflow X · run Y", linking to the run that made the task. */
export function IssueOriginSection({ issue }: { issue: Issue }) {
   const orgId = useOrgId();
   const origin = issue.origin;
   const workflow = useWorkflowsStore((state) =>
      origin ? state.workflows.find((candidate) => candidate.id === origin.workflowId) : undefined
   );
   if (!origin) return null;
   return (
      <Section title="Created by">
         <Link
            href={`/${orgId}/workflow/${origin.workflowId}/run/${origin.workflowRunId}`}
            className="-mx-1.5 flex min-w-0 items-center gap-2 rounded px-1.5 py-1 hover:bg-sidebar/50"
         >
            <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0">
               <span className="block truncate">{workflow?.name ?? 'A workflow'}</span>
               <span className="block truncate text-muted-foreground">
                  run {origin.workflowRunId.slice(0, 8)}
               </span>
            </span>
         </Link>
      </Section>
   );
}

function DependencyRow({
   dependency,
   onRemove,
   removing,
}: {
   dependency: IssueDependencyRef;
   onRemove: () => void;
   removing: boolean;
}) {
   const orgId = useOrgId();
   const status = uiStatusFromApi(dependency.status);
   const StatusIcon = status?.icon;
   return (
      <li className="group -mx-1.5 flex min-w-0 items-center gap-1.5">
         <Link
            href={`/${orgId}/issue/${dependency.identifier}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 hover:bg-sidebar/50"
         >
            {StatusIcon ? (
               <StatusIcon />
            ) : (
               <Ban className="size-3.5 shrink-0 text-status-warning" />
            )}
            <span className="shrink-0 text-muted-foreground">{dependency.identifier}</span>
            <span className="truncate">{dependency.title}</span>
         </Link>
         <Button
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={`Remove ${dependency.identifier}`}
            disabled={removing}
            onClick={onRemove}
         >
            <X className="size-3" />
         </Button>
      </li>
   );
}

/**
 * What the task waits on and what waits on it. Adding goes through
 * `POST /issues/{id}/dependencies`; the server refuses a loop, and both
 * sides in the store are updated from its answer.
 */
export function IssueDependenciesSection({ issue }: { issue: Issue }) {
   const issues = useIssuesStore((state) => state.issues);
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [open, setOpen] = useState(false);
   const [busyId, setBusyId] = useState<string | null>(null);
   const [lists, setLists] = useState<IssueDependencyLists | null>(null);
   const issueId = issue.id;

   // The board list hydrates the store and carries a task's `dependsOn` but
   // not what it blocks, and every board event re-hydrates it. So the panel
   // keeps its own copy from the dependency read, which has both sides, and
   // only mirrors `dependsOn` into the store for the board to show.
   useEffect(() => {
      let cancelled = false;
      setLists(null);
      void listIssueDependencies(issueId)
         .then((fetched) => {
            if (cancelled) return;
            setLists(fetched);
            updateIssue(issueId, fetched);
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [issueId, updateIssue]);

   const dependsOn = lists?.dependsOn ?? issue.dependsOn ?? [];
   const blocks = lists?.blocks ?? issue.blocks ?? [];
   const excluded = new Set([
      issue.id,
      ...dependsOn.map((entry) => entry.id),
      ...blocks.map((entry) => entry.id),
   ]);
   const candidates = issues.filter((candidate) => !excluded.has(candidate.id));

   const add = async (other: Issue) => {
      setOpen(false);
      setBusyId(other.id);
      try {
         const next = await addIssueDependency(issue.id, other.id);
         setLists(next);
         updateIssue(issue.id, next);
         const known = issues.find((candidate) => candidate.id === other.id);
         if (known) {
            const mine: IssueDependencyRef = {
               id: issue.id,
               identifier: issue.identifier,
               title: issue.title,
               status: issue.status.id,
            };
            updateIssue(other.id, {
               blocks: [...(known.blocks ?? []).filter((entry) => entry.id !== issue.id), mine],
            });
         }
      } catch (error) {
         toast.error(describeDependencyFailure(error));
      } finally {
         setBusyId(null);
      }
   };

   const remove = async (
      dependent: string,
      blocker: IssueDependencyRef,
      side: 'dependsOn' | 'blocks'
   ) => {
      setBusyId(blocker.id);
      try {
         await removeIssueDependency(dependent, side === 'dependsOn' ? blocker.id : issue.id);
         const next: IssueDependencyLists = {
            dependsOn: dependsOn.filter((entry) => side !== 'dependsOn' || entry.id !== blocker.id),
            blocks: blocks.filter((entry) => side !== 'blocks' || entry.id !== blocker.id),
         };
         setLists(next);
         updateIssue(issue.id, next);
         const other = issues.find((candidate) => candidate.id === blocker.id);
         if (other) {
            const mirror = side === 'dependsOn' ? 'blocks' : 'dependsOn';
            updateIssue(other.id, {
               [mirror]: (other[mirror] ?? []).filter((entry) => entry.id !== issue.id),
            });
         }
      } catch (error) {
         toast.error(describeDependencyFailure(error));
      } finally {
         setBusyId(null);
      }
   };

   const picker = (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button
               variant="ghost"
               size="icon"
               className="size-6 text-muted-foreground"
               aria-label="Add a task this one waits on"
               disabled={busyId !== null}
            >
               <Plus className="size-3.5" />
            </Button>
         </PopoverTrigger>
         <PopoverContent className="w-80 p-0" align="end">
            <Command>
               <CommandInput placeholder="Wait on which task?" />
               <CommandList>
                  <CommandEmpty>No task matches.</CommandEmpty>
                  <CommandGroup>
                     {candidates.map((candidate) => (
                        <CommandItem
                           key={candidate.id}
                           value={`${candidate.identifier} ${candidate.title}`}
                           onSelect={() => void add(candidate)}
                           className="flex items-center gap-2"
                        >
                           <candidate.status.icon />
                           <span className="shrink-0 text-muted-foreground">
                              {candidate.identifier}
                           </span>
                           <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                        </CommandItem>
                     ))}
                  </CommandGroup>
               </CommandList>
            </Command>
         </PopoverContent>
      </Popover>
   );

   return (
      <>
         <Section title="Blocked by" action={picker}>
            {dependsOn.length === 0 ? (
               <p className="text-muted-foreground">Waits on nothing.</p>
            ) : (
               <ul className="flex flex-col">
                  {dependsOn.map((dependency) => (
                     <DependencyRow
                        key={dependency.id}
                        dependency={dependency}
                        removing={busyId === dependency.id}
                        onRemove={() => void remove(issue.id, dependency, 'dependsOn')}
                     />
                  ))}
               </ul>
            )}
            {dependsOn.some((entry) => entry.status !== 'done' && entry.status !== 'cancelled') && (
               <p className="mt-1 text-muted-foreground">Starts once every task above is done.</p>
            )}
         </Section>
         {blocks.length > 0 && (
            <Section title="Blocks">
               <ul className="flex flex-col">
                  {blocks.map((dependency) => (
                     <DependencyRow
                        key={dependency.id}
                        dependency={dependency}
                        removing={busyId === dependency.id}
                        onRemove={() => void remove(dependency.id, dependency, 'blocks')}
                     />
                  ))}
               </ul>
            </Section>
         )}
      </>
   );
}

/** The gate holding a task before it may start, with the decision inline. */
export function IssueApprovalSection({ issue }: { issue: Issue }) {
   const approval = useApprovalsStore((state) =>
      state.approvals.find(
         (candidate) => candidate.issueId === issue.id && isApprovalPending(candidate)
      )
   );
   if (!approval) return null;
   return (
      <Section title="Waiting for approval">
         <ApprovalCard approval={approval} compact />
      </Section>
   );
}
