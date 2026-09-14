'use client';

import { Progress } from '@/components/ui/progress';
import { describeGoalProgress, type GoalProgress as GoalProgressData } from '@/lib/goals';
import { cn } from '@/lib/utils';

interface GoalProgressProps {
   progress: GoalProgressData | null | undefined;
   /** Bar only, for a list row. */
   compact?: boolean;
   className?: string;
}

/** Tasks done over tasks total, with the approvals beside it. */
export function GoalProgress({ progress, compact = false, className }: GoalProgressProps) {
   const total = progress?.issuesTotal ?? 0;
   const done = progress?.issuesDone ?? 0;
   const percent = total > 0 ? Math.round((done / total) * 100) : 0;
   if (compact) {
      return (
         <span className={cn('inline-flex items-center gap-2', className)}>
            <Progress
               value={percent}
               className="h-1.5 w-20"
               aria-label={`${percent}% of tasks done`}
            />
            <span className="tabular-nums text-muted-foreground">
               {total > 0 ? `${done}/${total}` : '—'}
            </span>
         </span>
      );
   }
   // A goal is its tasks, so one with none has nothing to show a bar for —
   // drawing an empty track there reads as progress that has not moved.
   if (total === 0) return null;
   return (
      <div className={className}>
         <div className="flex items-center justify-between gap-3">
            <span className="font-medium">{percent}% done</span>
            <span className="text-muted-foreground">{describeGoalProgress(progress)}</span>
         </div>
         <Progress value={percent} className="mt-2 h-2" aria-label={`${percent}% of tasks done`} />
      </div>
   );
}
