'use client';

import { AutoReview, loadAutoReviews } from '@/lib/runs';
import { cn } from '@/lib/utils';
import { CircleCheck, CircleX, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * What the peer reviewer decided, and why.
 *
 * A rejected AutoGate review left the task sitting in review with nothing to
 * read — the verdict was recorded and the reason written, and no surface
 * showed either, so a task an agent had declined to approve looked exactly
 * like one nobody had looked at yet. The reason is the useful part: it says
 * what to fix before the task is worth running again.
 */
export function IssueReviews({ issueRef }: { issueRef: string }) {
   const [reviews, setReviews] = useState<AutoReview[]>([]);

   useEffect(() => {
      if (!issueRef) {
         setReviews([]);
         return;
      }
      let cancelled = false;
      void loadAutoReviews(issueRef)
         .then((loaded) => {
            if (!cancelled) setReviews(loaded);
         })
         .catch(() => {
            if (!cancelled) setReviews([]);
         });
      return () => {
         cancelled = true;
      };
   }, [issueRef]);

   if (reviews.length === 0) return null;

   return (
      <div className="mt-6">
         <h3 className="mb-2 flex items-center gap-1.5 font-medium text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            AutoGate review
         </h3>
         <div className="flex flex-col gap-2">
            {reviews.map((review) => (
               <div
                  key={review.id}
                  className={cn(
                     'rounded-md border p-3',
                     review.approved
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-amber-500/30 bg-amber-500/5'
                  )}
               >
                  <div className="mb-1 flex items-center gap-1.5">
                     {review.approved ? (
                        <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                     ) : (
                        <CircleX className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                     )}
                     <span className="font-medium">
                        {review.approved ? 'Approved' : 'Changes requested'}
                     </span>
                     <span className="truncate text-muted-foreground">
                        by {review.reviewer}, reviewing {review.author}
                     </span>
                  </div>
                  <p className="whitespace-pre-wrap text-muted-foreground">{review.reason}</p>
                  {review.approved ? null : (
                     <p className="mt-2 text-muted-foreground">
                        The task stays in review. Nothing moves it to Done until it passes
                        or you move it yourself.
                     </p>
                  )}
               </div>
            ))}
         </div>
      </div>
   );
}
