'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useGoalsStore } from '@/store/goals-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import GoalLine from './goal-line';

function EmptyGoals() {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   return (
      <div className="flex min-h-64 w-full items-center justify-center px-6 py-12">
         <div className="flex max-w-sm flex-col items-center text-center">
            <BerryMark size="lg" tone="neutral" state="hollow" label="No goals" />
            <h2 className="mt-5 font-display tracking-[-0.025em]">No goals yet.</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">
               A goal is the group of tasks one plan produced. Plan work in a project and the goal
               arrives with the tasks.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
               <Button asChild className="h-10 px-5">
                  <Link href={`/${orgId}/projects`}>go to projects</Link>
               </Button>
            </div>
         </div>
      </div>
   );
}

export default function Goals() {
   const goals = useGoalsStore((state) => state.goals);
   const loaded = useGoalsStore((state) => state.loaded);
   const error = useGoalsStore((state) => state.error);

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Goal</div>
            <div className="w-27.5 shrink-0">Status</div>
            <div className="hidden w-40 shrink-0 sm:block">Progress</div>
            <div className="hidden w-28 shrink-0 md:block">Updated</div>
         </div>
         {!loaded && !error ? (
            <div className="px-6 py-10 text-muted-foreground">Loading goals…</div>
         ) : error ? (
            <div className="px-6 py-10 text-muted-foreground" role="alert">
               {error}
            </div>
         ) : goals.length === 0 ? (
            <EmptyGoals />
         ) : (
            goals.map((goal) => <GoalLine key={goal.id} goal={goal} />)
         )}
      </div>
   );
}
