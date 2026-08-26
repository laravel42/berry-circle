'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { GoalStatusBadge } from '@/components/common/goals/goal-status-badge';
import { useDetailDrawerClose } from '@/components/layout/detail-drawer-context';
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
import { Button, buttonVariants } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { GOAL_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import {
   archiveGoal,
   describeGoalFailure,
   describeGoalStatus,
   goalTransitions,
   patchGoal,
   type GoalStatus,
} from '@/lib/goals';
import { useCreatePlanStore } from '@/store/create-plan-store';
import { useCreateWorkflowStore } from '@/store/create-workflow-store';
import { useGoalsStore } from '@/store/goals-store';
import { ChevronRight, MoreHorizontal, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

/** Goal header: goals › mark + title, status, and the moves a person may make. */
export default function Header({ goalId }: { goalId: string }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const router = useRouter();
   const closeDrawer = useDetailDrawerClose();
   const goal = useGoalsStore((state) => state.goals.find((candidate) => candidate.id === goalId));
   const upsertGoal = useGoalsStore((state) => state.upsertGoal);
   const removeGoal = useGoalsStore((state) => state.removeGoal);
   const openCreatePlan = useCreatePlanStore((state) => state.openModal);
   const openCreateWorkflow = useCreateWorkflowStore((state) => state.openModal);
   const [busy, setBusy] = useState(false);
   const [archiveOpen, setArchiveOpen] = useState(false);

   const look = goal ? statusLook(GOAL_STATUS, goal.status) : null;
   const transitions = goal ? goalTransitions(goal.status) : [];

   const move = (status: GoalStatus) => {
      setBusy(true);
      void patchGoal(goalId, { status })
         .then((updated) => {
            upsertGoal(updated);
            toast.success(`Goal ${describeGoalStatus(updated.status).toLowerCase()}`);
         })
         .catch((error: unknown) => toast.error(describeGoalFailure(error)))
         .finally(() => setBusy(false));
   };

   const onArchive = () => {
      setBusy(true);
      void archiveGoal(goalId)
         .then(() => {
            removeGoal(goalId);
            toast.success('Goal archived');
            if (closeDrawer) closeDrawer();
            else router.push(`/${orgId}/goals`);
         })
         .catch((error: unknown) => toast.error(describeGoalFailure(error)))
         .finally(() => setBusy(false));
   };

   return (
      <div className="flex h-10 w-full items-center justify-between gap-4 border-b px-6 py-1.5">
         <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            <Link
               href={`/${orgId}/goals`}
               className="text-muted-foreground transition-colors hover:text-foreground"
            >
               Goals
            </Link>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <BerryMark size="sm" tone={look?.tone ?? 'neutral'} state={look?.state ?? 'hollow'} />
            <span className="truncate font-medium">{goal?.title ?? 'Loading goal…'}</span>
         </nav>
         <div className="flex shrink-0 items-center gap-2">
            {goal && <GoalStatusBadge status={goal.status} className="hidden sm:inline-flex" />}
            <Button
               size="xs"
               variant="secondary"
               disabled={!goal}
               onClick={() => openCreatePlan({ goalId, projectId: goal?.projectId ?? undefined })}
            >
               <Sparkles className="size-4" />
               <span className="hidden sm:inline">Plan</span>
            </Button>
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-7"
                     aria-label="Goal actions"
                     disabled={!goal || busy}
                  >
                     <MoreHorizontal className="size-4" />
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="min-w-48">
                  {transitions.map((transition) => (
                     <DropdownMenuItem
                        key={transition.status}
                        onClick={() => move(transition.status)}
                     >
                        {transition.label}
                     </DropdownMenuItem>
                  ))}
                  {transitions.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={() => openCreateWorkflow({ goalId })}>
                     New workflow for this goal
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                     className="text-status-danger focus:text-status-danger"
                     onClick={() => setArchiveOpen(true)}
                  >
                     Archive
                  </DropdownMenuItem>
               </DropdownMenuContent>
            </DropdownMenu>
         </div>
         <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>Archive “{goal?.title ?? 'this goal'}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                     The goal leaves the list. Its tasks keep their links and stay on the board.
                     Archiving needs settings access.
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>Keep</AlertDialogCancel>
                  <AlertDialogAction
                     className={buttonVariants({ variant: 'destructive' })}
                     onClick={onArchive}
                  >
                     Archive
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
