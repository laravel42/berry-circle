'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useIssuesStore } from '@/store/issues-store';
import type { ViewType } from '@/store/view-store';
import { AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** The load state of the task list, and the way back from a failure. */
export function useIssueListLoad() {
   const loadState = useIssuesStore((state) => state.loadState);
   const loadError = useIssuesStore((state) => state.loadError);
   const retry = useIssuesStore((state) => state.retryLoad);
   return { loadState, loadError, retry };
}

function Row() {
   return (
      <div className="flex items-center gap-3 border-b border-border/45 px-6 py-3">
         <Skeleton className="size-4 rounded-full" />
         <Skeleton className="h-3 w-16" />
         <Skeleton className="h-3 flex-1 max-w-96" />
         <Skeleton className="ml-auto size-6 rounded-full" />
      </div>
   );
}

function Card() {
   return (
      <div className="flex flex-col gap-2 rounded-lg border border-border/50 p-2">
         <Skeleton className="h-3 w-14" />
         <Skeleton className="h-3 w-full" />
         <Skeleton className="h-3 w-2/3" />
      </div>
   );
}

/**
 * The shape of the layout that is loading, rather than one spinner for all of
 * them: a board that resolves into a list, or a table that resolves into
 * cards, reads as the page changing its mind.
 */
export function IssueListSkeleton({ mode }: { mode: ViewType }) {
   if (mode === 'grid') {
      return (
         <div className="flex h-full min-w-max gap-3 px-4 py-3" aria-hidden>
            {[0, 1, 2].map((column) => (
               <div key={column} className="flex w-[278px] flex-col gap-1.5">
                  <Skeleton className="h-7 w-full rounded-lg" />
                  {[0, 1, 2].map((card) => (
                     <Card key={card} />
                  ))}
               </div>
            ))}
         </div>
      );
   }

   if (mode === 'table') {
      return (
         <div className="flex flex-col" aria-hidden>
            <div className="flex items-center gap-6 border-b px-4 py-2">
               {[0, 1, 2, 3].map((column) => (
                  <Skeleton key={column} className="h-3 w-24" />
               ))}
            </div>
            {[0, 1, 2, 3, 4, 5].map((row) => (
               <div key={row} className="flex items-center gap-6 border-b px-4 py-2.5">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-3 w-24" />
               </div>
            ))}
         </div>
      );
   }

   if (mode === 'swimlane') {
      return (
         <div
            className="grid gap-px p-4"
            style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}
            aria-hidden
         >
            {Array.from({ length: 12 }).map((_, cell) => (
               <Skeleton key={cell} className="h-16" />
            ))}
         </div>
      );
   }

   if (mode === 'gantt') {
      return (
         <div className="flex flex-col gap-2 p-4" aria-hidden>
            {[0, 1, 2, 3, 4].map((row) => (
               <div key={row} className="flex items-center gap-3">
                  <Skeleton className="h-3 w-52" />
                  <Skeleton className="h-5 flex-1" style={{ maxWidth: `${40 + row * 12}%` }} />
               </div>
            ))}
         </div>
      );
   }

   return (
      <div className="flex flex-col" aria-hidden>
         <Skeleton className="mx-6 my-2 h-4 w-32" />
         {[0, 1, 2, 3, 4, 5, 6].map((row) => (
            <Row key={row} />
         ))}
      </div>
   );
}

/** The list could not be loaded at all — say why, and offer the way back. */
export function IssueListError({ message, onRetry }: { message: string; onRetry: () => void }) {
   const t = useTranslations('issueLists');

   return (
      <div className="flex min-h-64 w-full items-center justify-center px-6 py-12">
         <div className="flex max-w-sm flex-col items-center text-center">
            <AlertTriangle className="size-5 text-status-warning" />
            <p className="mt-4 leading-relaxed text-muted-foreground">
               {message || t('states.loadFailed')}
            </p>
            <Button variant="secondary" className="mt-5" onClick={onRetry}>
               {t('states.retry')}
            </Button>
         </div>
      </div>
   );
}
