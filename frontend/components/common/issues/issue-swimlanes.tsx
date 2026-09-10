'use client';

import type { Issue } from '@/data/issues';
import type { Status } from '@/data/status';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';

/** Rows by assignee, columns by status. */
export function IssueSwimlanes({ issues, statuses }: { issues: Issue[]; statuses: Status[] }) {
   const { orgId } = useParams<{ orgId: string }>();
   const lanes = useMemo(() => {
      const byLane = new Map<string, { name: string; issues: Issue[] }>();
      for (const issue of issues) {
         const key = issue.assignee?.id ?? 'unassigned';
         const lane = byLane.get(key) ?? { name: issue.assignee?.name ?? 'Unassigned', issues: [] };
         lane.issues.push(issue);
         byLane.set(key, lane);
      }
      return [...byLane.entries()].sort(([a], [b]) => (a === 'unassigned' ? 1 : b === 'unassigned' ? -1 : 0));
   }, [issues]);

   return (
      <div className="h-full overflow-auto">
         <div className="grid min-w-max" style={{ gridTemplateColumns: `160px repeat(${statuses.length}, 240px)` }}>
            <div className="sticky top-0 z-10 border-b bg-container px-3 py-2" />
            {statuses.map((status) => (
               <div key={status.id} className="sticky top-0 z-10 border-b bg-container px-3 py-2 font-medium">
                  {status.name}
               </div>
            ))}
            {lanes.map(([key, lane]) => (
               <div key={key} className="contents">
                  <div className="border-b px-3 py-2 font-medium">{lane.name}</div>
                  {statuses.map((status) => (
                     <div key={status.id} className="flex flex-col gap-1 border-b border-l p-2">
                        {lane.issues
                           .filter((issue) => issue.status.id === status.id)
                           .map((issue) => (
                              <Link
                                 key={issue.id}
                                 href={`/${orgId}/issue/${issue.identifier}`}
                                 className="rounded border bg-background px-2 py-1 hover:bg-accent"
                              >
                                 <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
                              </Link>
                           ))}
                     </div>
                  ))}
               </div>
            ))}
         </div>
      </div>
   );
}
