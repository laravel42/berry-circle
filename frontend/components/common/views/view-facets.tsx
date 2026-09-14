'use client';

import type { View } from '@/data/views';
import { API_PRIORITY_BY_UI, API_STATUS_BY_UI } from '@/lib/catalog';
import { queryIssues, saveViewPreferences, type IssueQueryResult } from '@/lib/views';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';

/**
 * Counts for a view, computed by the server over the whole workspace rather
 * than over whatever the board has loaded. Opening a view also records it as
 * the person's active view.
 */
export function ViewFacets({ view }: { view: View }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [result, setResult] = useState<IssueQueryResult | null>(null);

   useEffect(() => {
      if (!workspaceId) return;
      const statuses = (view.filter.statusIds ?? []).map((id) => API_STATUS_BY_UI[id] ?? id);
      const priorities = (view.filter.priorityIds ?? []).map((id) => API_PRIORITY_BY_UI[id] ?? id);
      void queryIssues({
         workspaceId,
         filter: {
            ...(statuses.length ? { statuses } : {}),
            ...(priorities.length ? { priorities } : {}),
            ...(view.filter.labelIds?.length ? { labelIds: view.filter.labelIds } : {}),
            ...(view.filter.unassigned ? { unassigned: true } : {}),
         },
         groupBy: 'status',
         perGroup: 1,
      })
         .then(setResult)
         .catch(() => setResult(null));
      void saveViewPreferences(workspaceId, view.id, {}).catch(() => undefined);
   }, [workspaceId, view]);

   if (!result) return null;
   return (
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-2 text-muted-foreground">
         <span className="text-foreground">{result.total} tasks</span>
         {Object.entries(result.facets.status).map(([status, count]) => (
            <span key={status}>
               {status} {count}
            </span>
         ))}
      </div>
   );
}
