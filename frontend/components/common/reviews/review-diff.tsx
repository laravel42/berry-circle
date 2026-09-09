'use client';

import { Input } from '@/components/ui/input';
import { loadReviewDiff, parseUnifiedDiff, type ReviewItem } from '@/lib/reviews';
import type { FileDiff } from '@/data/reviews';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DiffView } from './diff-view';

/** Diff tab: the pull request's changes, one file at a time, filterable by path. */
export function ReviewDiff({ item }: { item: ReviewItem }) {
   const [query, setQuery] = useState('');
   const [files, setFiles] = useState<FileDiff[] | null>(null);
   const [error, setError] = useState<string | null>(null);

   useEffect(() => {
      let cancelled = false;
      setFiles(null);
      setError(null);
      if (!item.pullRequest) return;
      loadReviewDiff(item.run.id)
         .then((text) => {
            if (!cancelled) setFiles(parseUnifiedDiff(text));
         })
         .catch((cause: unknown) => {
            if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load the diff');
         });
      return () => {
         cancelled = true;
      };
   }, [item.run.id, item.pullRequest]);

   const shown = useMemo(
      () => (files ?? []).filter((file) => `${file.path}/${file.name}`.toLowerCase().includes(query.trim().toLowerCase())),
      [files, query]
   );

   if (!item.pullRequest) {
      return <div className="h-full flex items-center justify-center text-muted-foreground">This run opened no pull request.</div>;
   }

   return (
      <div className="h-full flex flex-col overflow-hidden">
         <div className="flex items-center justify-between gap-2 px-4 py-2 border-b shrink-0">
            <span className="font-medium">
               Files <span className="text-muted-foreground">{files ? files.length : '…'}</span>
            </span>
            <div className="relative w-64">
               <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
               <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter files" className="h-7 pl-7" />
            </div>
         </div>
         <div className="flex-1 overflow-y-auto">
            <div className="max-w-6xl mx-auto px-6 py-6 flex flex-col gap-6">
               {error && <p className="text-muted-foreground" role="alert">{error}</p>}
               {!error && files === null && <p className="text-muted-foreground">Loading the diff…</p>}
               {shown.map((file) => (
                  <DiffView key={`${file.path}/${file.name}`} diff={file} />
               ))}
            </div>
         </div>
      </div>
   );
}
