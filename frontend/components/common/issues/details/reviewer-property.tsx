'use client';

import { AutoReview, loadAutoReviews } from '@/lib/runs';
import { CircleCheck, CircleX, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Who is reviewing this task, in the sidebar beside status and assignee.
 *
 * Shown from the moment the reviewer is picked rather than when it answers.
 * The verdict row is reserved before the model is called, so for the length of
 * that call — a minute or more on a large deliverable — this reads "reviewing"
 * instead of leaving the task looking untouched.
 *
 * Polls while a review is open. A review is short-lived and the page has no
 * stream for it; a request every few seconds for the minute it lasts is
 * cheaper than the machinery to push it.
 */
export function ReviewerProperty({ issueRef }: { issueRef: string }) {
   const [review, setReview] = useState<AutoReview | null>(null);

   useEffect(() => {
      if (!issueRef) {
         setReview(null);
         return;
      }
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const read = () => {
         void loadAutoReviews(issueRef)
            .then((reviews) => {
               if (cancelled) return;
               const latest = reviews[0] ?? null;
               setReview(latest);
               if (latest?.inProgress) timer = setTimeout(read, 4000);
            })
            .catch(() => {
               if (!cancelled) setReview(null);
            });
      };
      read();

      return () => {
         cancelled = true;
         if (timer) clearTimeout(timer);
      };
   }, [issueRef]);

   if (!review) return null;

   return (
      <div className="mt-0.5 flex items-center gap-2" title={reviewTitle(review)}>
         {review.inProgress ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
         ) : review.approved ? (
            <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
         ) : (
            <CircleX className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
         )}
         <span className="truncate">{review.reviewer}</span>
         <span className="shrink-0 text-muted-foreground">
            {review.inProgress ? 'reviewing' : review.approved ? 'approved' : 'sent back'}
         </span>
      </div>
   );
}

function reviewTitle(review: AutoReview): string {
   if (review.inProgress) {
      return `${review.reviewer} is reviewing what ${review.author} produced`;
   }
   const outcome = review.approved ? 'approved' : 'sent this back';
   return `${review.reviewer} ${outcome} (attempt ${review.attempt})`;
}

/** The icon the section header uses, so the panel and the block agree. */
export const ReviewerIcon = ShieldCheck;
