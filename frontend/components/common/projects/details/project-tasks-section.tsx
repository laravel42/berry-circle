'use client';

import { IssueLine } from '@/components/common/issues/issue-line';
import { Issue } from '@/data/issues';
import { displayOrderedStatus } from '@/data/status';
import { useMemo } from 'react';
import { DetailSectionLabel } from './detail-section-label';
import { renderStatusIcon } from '@/lib/status-utils';

/** Compact project task list for the unified project detail view. */
export function ProjectTasksSection({ issues }: { issues: Issue[] }) {
   const grouped = useMemo(() => {
      return displayOrderedStatus
         .map((status) => ({
            status,
            issues: issues.filter((issue) => issue.status.id === status.id),
         }))
         .filter((group) => group.issues.length > 0);
   }, [issues]);

   return (
      <section>
         <DetailSectionLabel>tasks</DetailSectionLabel>
         {issues.length === 0 ? (
            <p className="text-muted-foreground">No tasks linked to this project yet.</p>
         ) : (
            <div className="flex flex-col gap-4">
               {grouped.map(({ status, issues: statusIssues }) => (
                  <div key={status.id}>
                     <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground">
                        {renderStatusIcon(status.id)}
                        <span>{status.name}</span>
                        <span className="tabular-nums">{statusIssues.length}</span>
                     </div>
                     <div className="overflow-hidden rounded-md border border-border/45">
                        {statusIssues.map((issue) => (
                           <IssueLine key={issue.id} issue={issue} />
                        ))}
                     </div>
                  </div>
               ))}
            </div>
         )}
      </section>
   );
}
