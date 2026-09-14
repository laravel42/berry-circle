'use client';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { decideReview, loadReviews, type ReviewDecision, type ReviewItem } from '@/lib/reviews';
import { describePatchFailure } from '@/lib/issues';
import { useSessionStore } from '@/store/session-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ReviewDiff } from './review-diff';
import { ReviewVerdicts } from './review-guide';
import { ReviewOverview } from './review-overview';
import { DiffStat, IssueCheckIcon, PrIcon } from './review-shared';
import { reviewStatusOf } from './reviews';

export type ReviewSection = 'overview' | 'guide' | 'diff';

const SECTION_TABS: { key: ReviewSection; label: string; path: string }[] = [
   { key: 'overview', label: 'Overview', path: '' },
   { key: 'guide', label: 'Verdicts', path: '/review' },
   { key: 'diff', label: 'Diff', path: '/changes' },
];

/**
 * Right pane of the Reviews split view: the task, the pull request, and the
 * decision. The item is found in either list, because a decided task is still
 * worth opening; the buttons show only while it waits.
 */
export function ReviewDetail({
   reviewId,
   section,
   onDecided,
}: {
   reviewId: string;
   section: ReviewSection;
   onDecided?: () => void | Promise<void>;
}) {
   const { orgId } = useParams<{ orgId: string }>();
   const workspace = useSessionStore((state) => state.workspace);
   const [item, setItem] = useState<ReviewItem | null | undefined>(undefined);
   const [note, setNote] = useState('');
   const [pending, setPending] = useState<ReviewDecision | null>(null);

   const load = useCallback(async () => {
      if (!workspace) return;
      const [open, completed] = await Promise.all([
         loadReviews(workspace.id, 'open'),
         loadReviews(workspace.id, 'completed'),
      ]);
      setItem([...open, ...completed].find((candidate) => candidate.id === reviewId) ?? null);
   }, [workspace, reviewId]);

   useEffect(() => {
      void load();
   }, [load]);

   if (item === undefined) {
      return <div className="h-full flex items-center justify-center text-muted-foreground">Loading review…</div>;
   }
   if (item === null) {
      return <div className="h-full flex items-center justify-center text-muted-foreground">Review not found</div>;
   }

   const status = reviewStatusOf(item);
   const waiting = item.issue.status === 'in_review';

   const decide = (decision: ReviewDecision) => {
      setPending(decision);
      void decideReview(item, decision, note)
         .then(async () => {
            toast.success(decision === 'approve' ? 'Approved' : 'Sent back');
            setNote('');
            await load();
            await onDecided?.();
         })
         .catch((error: unknown) => toast.error(describePatchFailure(error)))
         .finally(() => setPending(null));
   };

   return (
      <div className="h-full flex flex-col overflow-hidden">
         <div className="flex items-center gap-2 px-4 h-10 border-b shrink-0 min-w-0">
            <Link href={`/${orgId}/issue/${item.issue.identifier}`} className="flex items-center gap-1.5 shrink-0 hover:opacity-80">
               <IssueCheckIcon />
               <span className="font-medium">{item.issue.identifier}</span>
            </Link>
            <span className="text-muted-foreground shrink-0">›</span>
            <PrIcon status={status} />
            <span className="font-medium truncate">{item.issue.title}</span>
            <DiffStat additions={item.delivery.insertions} deletions={item.delivery.deletions} />
            <span className="flex-1" />
            {item.pullRequest?.url && (
               <a href={item.pullRequest.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground shrink-0">
                  PR #{item.pullRequest.number}
               </a>
            )}
         </div>
         <div className="flex items-center justify-between px-4 h-10 border-b shrink-0">
            <div className="flex items-center gap-1.5">
               {SECTION_TABS.map((tab) => (
                  <Link
                     key={tab.key}
                     href={`/${orgId}/review/${item.id}${tab.path}`}
                     className={cn('px-2.5 py-1 rounded-md border font-medium transition-colors', section === tab.key ? 'bg-accent border-transparent' : 'text-muted-foreground hover:bg-accent/50')}
                  >
                     {tab.label}
                     {tab.key === 'guide' && item.verdicts.length > 0 && (
                        <span className="ml-1 text-muted-foreground">{item.verdicts.length}</span>
                     )}
                  </Link>
               ))}
            </div>
         </div>
         <div className="flex-1 min-h-0 overflow-hidden">
            {section === 'overview' && <ReviewOverview item={item} />}
            {section === 'guide' && <ReviewVerdicts item={item} />}
            {section === 'diff' && <ReviewDiff item={item} />}
         </div>
         {waiting && (
            <div className="shrink-0 border-t border-border/60 bg-container px-4 py-3">
               <Textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="A note for the author — required when sending back, optional when approving."
                  className="min-h-16"
               />
               <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-muted-foreground">
                     Approve marks the task done. Send back returns it to todo with your note; the agent reads it on its next run.
                  </p>
                  <div className="flex shrink-0 items-center gap-2">
                     <Button size="sm" variant="secondary" disabled={pending !== null || note.trim() === ''} onClick={() => decide('send-back')}>
                        {pending === 'send-back' ? 'Sending back…' : 'Send back'}
                     </Button>
                     <Button size="sm" disabled={pending !== null} onClick={() => decide('approve')}>
                        {pending === 'approve' ? 'Approving…' : 'Approve'}
                     </Button>
                  </div>
               </div>
            </div>
         )}
      </div>
   );
}
