'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { cn } from '@/lib/utils';
import { loadReviews, reviewTimeAgo, type ReviewItem, type ReviewQueueState } from '@/lib/reviews';
import { useSessionStore } from '@/store/session-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ReactNode, useCallback, useEffect, useState } from 'react';
import { ReviewDetail, ReviewSection } from './review-detail';
import { PrIcon } from './review-shared';

/** Hand-drawn empty-state sketch (paper plane over a folded sheet). */
function EmptySketch() {
   return (
      <svg width="150" height="120" viewBox="0 0 150 120" fill="none" aria-hidden>
         <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M28 78l58-22 34 30-64 16z" />
            <path d="M28 78l30-6 28 28" />
            <path d="M86 56l-8 40" strokeDasharray="4 4" />
            <path d="M104 34c8-10 22-12 26-6s-4 16-14 18" />
            <path d="M116 46c-4 2-8 2-12 0" />
            <path d="M44 66l6-2M56 84l6-2M70 92l6-2" strokeDasharray="3 4" />
         </g>
      </svg>
   );
}

/** How a task at the gate reads in the list: what the last decision on it was. */
export function reviewStatusOf(item: ReviewItem): 'open' | 'merged' | 'closed' {
   if (item.issue.status === 'in_review') return 'open';
   if (item.issue.status === 'done') return 'merged';
   return 'closed';
}

function ReviewRow({ item, orgId, selected }: { item: ReviewItem; orgId: string; selected: boolean }) {
   const latest = item.verdicts[0];
   return (
      <Link
         href={`/${orgId}/review/${item.id}`}
         className={cn(
            'flex items-center gap-2 px-4 py-2 border-b border-border/40 transition-colors',
            selected ? 'bg-accent/60' : 'hover:bg-sidebar/50'
         )}
      >
         <PrIcon status={reviewStatusOf(item)} />
         <span className="text-muted-foreground shrink-0">{item.issue.identifier}</span>
         <span className="flex-1 truncate">{item.issue.title}</span>
         {latest && latest.approved !== null && (
            <span
               className={cn(
                  'shrink-0 rounded px-1.5 py-px',
                  latest.approved ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-600'
               )}
               title={`Peer review by ${latest.reviewer}`}
            >
               {latest.approved ? 'peer ok' : 'peer no'}
            </span>
         )}
         <span className="text-muted-foreground shrink-0">{reviewTimeAgo(item.run.completedAt ?? item.updatedAt)}</span>
      </Link>
   );
}

/** Collapsible status group: the header arrow really opens and closes the rows. */
function ReviewGroup({ label, count, children }: { label: string; count: number; children: ReactNode }) {
   const [open, setOpen] = useState(true);
   return (
      <div>
         <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="w-full flex items-center gap-1.5 px-4 py-1.5 font-medium bg-[color-mix(in_oklab,var(--accent)_30%,var(--container))] border-b border-border/40 cursor-pointer select-none"
         >
            {label}
            <svg width="8" height="8" viewBox="0 0 8 8" className={cn('text-muted-foreground transition-transform duration-200', !open && '-rotate-90')} aria-hidden>
               <path d="M1 3l3 3 3-3" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
            <span className="ml-auto text-muted-foreground font-normal">{count}</span>
         </button>
         <div className={cn('grid transition-[grid-template-rows] duration-200 ease-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
            <div className="overflow-hidden">{children}</div>
         </div>
      </div>
   );
}

/** The two lists: what waits for a decision, and what was decided. */
export type ReviewList = 'for-you' | 'created';

interface ReviewsProps {
   /** Which list tab is active ("/reviews" waits, "/reviews/created" decided). */
   listTab?: ReviewList;
   /** Selected review (detail routes). The id is the task's. */
   selectedReviewId?: string;
   section?: ReviewSection;
}

/**
 * Reviews split view: the tasks at the review gate on the left, the evidence
 * for one on the right. Loaded from the API for the active workspace; a
 * decision on the right refreshes the left.
 */
export default function Reviews({ listTab = 'for-you', selectedReviewId, section = 'overview' }: ReviewsProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const workspace = useSessionStore((state) => state.workspace);
   const state: ReviewQueueState = listTab === 'for-you' ? 'open' : 'completed';
   const [items, setItems] = useState<ReviewItem[] | null>(null);
   const [error, setError] = useState<string | null>(null);

   const reload = useCallback(async () => {
      if (!workspace) return;
      try {
         setItems(await loadReviews(workspace.id, state));
         setError(null);
      } catch (cause) {
         setError(cause instanceof Error ? cause.message : 'Could not load reviews');
      }
   }, [workspace, state]);

   useEffect(() => {
      void reload();
   }, [reload]);

   const groups = [
      { label: state === 'open' ? 'Waiting for a decision' : 'Approved', status: state === 'open' ? 'open' : 'merged' },
      { label: 'Sent back', status: 'closed' },
   ]
      .map((group) => ({ ...group, items: (items ?? []).filter((item) => reviewStatusOf(item) === group.status) }))
      .filter((group) => group.items.length > 0);

   return (
      <div className="w-full h-full flex overflow-hidden">
         <div className="w-[420px] max-w-[45%] shrink-0 border-r h-full flex flex-col bg-container">
            <div className="flex items-center justify-between px-4 py-1.5 h-10 border-b shrink-0">
               <span className="font-medium">Reviews</span>
            </div>
            <div className="flex items-center gap-1.5 px-4 py-2 shrink-0">
               <Link
                  href={`/${orgId}/reviews`}
                  className={cn('px-2.5 py-1 rounded-md border font-medium transition-colors', listTab === 'for-you' ? 'bg-accent border-transparent' : 'text-muted-foreground hover:bg-accent/50')}
               >
                  Waiting
               </Link>
               <Link
                  href={`/${orgId}/reviews/created`}
                  className={cn('px-2.5 py-1 rounded-md border font-medium transition-colors', listTab === 'created' ? 'bg-accent border-transparent' : 'text-muted-foreground hover:bg-accent/50')}
               >
                  Decided
               </Link>
            </div>
            <div className="flex-1 overflow-y-auto">
               {items === null && !error && <div className="px-4 py-6 text-muted-foreground">Loading reviews…</div>}
               {error && <div className="px-4 py-6 text-muted-foreground" role="alert">{error}</div>}
               {groups.map((group) => (
                  <ReviewGroup key={group.label} label={group.label} count={group.items.length}>
                     {group.items.map((item) => (
                        <ReviewRow key={item.id} item={item} orgId={orgId} selected={item.id === selectedReviewId} />
                     ))}
                  </ReviewGroup>
               ))}
               {items !== null && items.length === 0 && !error && (
                  <div className="px-6 py-10 text-muted-foreground">
                     {state === 'open' ? 'Nothing is waiting for review.' : 'Nothing has been decided yet.'}
                  </div>
               )}
            </div>
         </div>

         <div className="flex-1 min-w-0 h-full overflow-hidden">
            {selectedReviewId ? (
               <ReviewDetail reviewId={selectedReviewId} section={section} onDecided={reload} />
            ) : (
               <div className="h-full flex flex-col items-center justify-center gap-4 text-muted-foreground">
                  <EmptySketch />
                  <span className="flex items-center gap-2">
                     <BerryMark size="sm" tone="neutral" />
                     {items ? `${items.length} ${state === 'open' ? 'waiting' : 'decided'}` : ''}
                  </span>
               </div>
            )}
         </div>
      </div>
   );
}
