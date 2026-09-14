'use client';

import { reviewTimeAgo, type ReviewItem } from '@/lib/reviews';

/** Every peer verdict on the task, newest first, with its reason. */
export function ReviewVerdicts({ item }: { item: ReviewItem }) {
   if (item.verdicts.length === 0) {
      return (
         <div className="h-full flex items-center justify-center text-muted-foreground">
            {item.issue.autoGate ? 'No peer verdict yet.' : 'This task did not opt into peer review.'}
         </div>
      );
   }
   return (
      <div className="h-full overflow-y-auto">
         <div className="max-w-3xl mx-auto px-6 py-6 flex flex-col gap-4">
            {item.verdicts.map((verdict) => (
               <div key={verdict.id} className="rounded-md border border-border/60 bg-background px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                     <span className="font-medium">
                        {verdict.approved === null ? 'Reviewing' : verdict.approved ? 'Approved' : 'Sent back'}
                     </span>
                     <span className="text-muted-foreground">by {verdict.reviewer}</span>
                     <span className="text-muted-foreground">· attempt {verdict.attempt}</span>
                     {verdict.decidedAt && <span className="text-muted-foreground">· {reviewTimeAgo(verdict.decidedAt)} ago</span>}
                  </div>
                  {verdict.reason && <p className="mt-1.5 whitespace-pre-line leading-6">{verdict.reason}</p>}
               </div>
            ))}
         </div>
      </div>
   );
}
