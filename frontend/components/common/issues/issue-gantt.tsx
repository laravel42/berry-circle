'use client';

import type { Issue } from '@/data/issues';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

const DAY = 86_400_000;

/**
 * Created-to-due bars on a day axis. A task without a due date has no span to
 * draw, so it is listed below rather than given a made-up one.
 */
export function IssueGantt({ issues }: { issues: Issue[] }) {
   const { orgId } = useParams<{ orgId: string }>();
   const { dated, undated, start, days } = useMemo(() => {
      const withDue = issues.filter((issue) => issue.dueDate);
      const starts = withDue.map((issue) => Date.parse(issue.createdAt));
      const ends = withDue.map((issue) => Date.parse(issue.dueDate ?? issue.createdAt));
      const first = starts.length ? Math.min(...starts) : Date.now();
      const last = ends.length ? Math.max(...ends) : Date.now();
      const span = Math.min(180, Math.max(7, Math.ceil((last - first) / DAY) + 1));
      return { dated: withDue, undated: issues.filter((issue) => !issue.dueDate), start: first, days: span };
   }, [issues]);

   const percent = (time: number) => Math.max(0, Math.min(100, ((time - start) / (days * DAY)) * 100));

   return (
      <div className="flex h-full flex-col overflow-auto px-4 py-3">
         <div className="mb-2 flex justify-between text-muted-foreground">
            <span>{new Date(start).toISOString().slice(0, 10)}</span>
            <span>{new Date(start + days * DAY).toISOString().slice(0, 10)}</span>
         </div>
         <div className="flex flex-col gap-1">
            {dated.map((issue) => {
               const left = percent(Date.parse(issue.createdAt));
               const right = percent(Date.parse(issue.dueDate ?? issue.createdAt));
               return (
                  <div key={issue.id} className="grid grid-cols-[240px_1fr] items-center gap-3">
                     <Link href={`/${orgId}/issue/${issue.identifier}`} className="truncate hover:underline">
                        <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                     </Link>
                     <div className="relative h-5 rounded bg-accent/40">
                        <div
                           className="absolute top-0 h-5 rounded bg-primary/70"
                           style={{ left: `${left}%`, width: `${Math.max(1, right - left)}%` }}
                           title={`${issue.createdAt.slice(0, 10)} to ${issue.dueDate?.slice(0, 10) ?? ''}`}
                        />
                     </div>
                  </div>
               );
            })}
         </div>
         {undated.length > 0 ? (
            <div className="mt-6">
               <div className="mb-1 text-muted-foreground">No due date ({undated.length})</div>
               <ul className="flex flex-col gap-0.5">
                  {undated.map((issue) => (
                     <li key={issue.id}>
                        <Link href={`/${orgId}/issue/${issue.identifier}`} className="hover:underline">
                           <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                        </Link>
                     </li>
                  ))}
               </ul>
            </div>
         ) : null}
      </div>
   );
}
