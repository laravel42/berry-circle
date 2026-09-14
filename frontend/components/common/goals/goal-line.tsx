'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { GOAL_STATUS, statusLook } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import type { Goal } from '@/lib/goals';
import { useProjectsStore } from '@/store/projects-store';
import { formatDistanceToNow, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GoalProgress } from './goal-progress';
import { GoalStatusBadge } from './goal-status-badge';

function relativeTime(iso: string): string {
   try {
      return formatDistanceToNow(parseISO(iso), { addSuffix: true });
   } catch {
      return iso;
   }
}

export default function GoalLine({ goal }: { goal: Goal }) {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const look = statusLook(GOAL_STATUS, goal.status);
   const project = useProjectsStore((state) =>
      goal.projectId
         ? state.projects.find((candidate) => candidate.id === goal.projectId)
         : undefined
   );

   return (
      <Link
         href={`/${orgId}/goal/${goal.id}/overview`}
         className="flex w-full items-center border-b border-muted-foreground/5 px-6 py-3 last:border-b-0 hover:bg-sidebar/50"
      >
         <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40">
               <BerryMark size="sm" tone={look.tone} state={look.state} label={look.label} />
            </span>
            <div className="min-w-0 overflow-hidden">
               <span className="block truncate font-medium leading-none">{goal.title}</span>
               <p className="mt-0.5 line-clamp-1 text-muted-foreground">
                  {project ? project.name : goal.description || 'No description'}
               </p>
            </div>
         </div>

         <div className="w-27.5 shrink-0">
            <GoalStatusBadge status={goal.status} />
         </div>

         <div className="hidden w-40 shrink-0 sm:block">
            {goal.progress ? (
               <GoalProgress progress={goal.progress} compact />
            ) : (
               <span className="text-muted-foreground">—</span>
            )}
         </div>

         <div className="hidden w-28 shrink-0 text-muted-foreground md:block">
            {relativeTime(goal.updatedAt)}
         </div>
      </Link>
   );
}
