'use client';

import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import type { Issue } from '@/data/issues';
import { describePatchFailure } from '@/lib/issues';
import { setCustomStatus } from '@/lib/issue-tracking';
import { loadStatuses, type WorkspaceStatus } from '@/lib/settings';
import { useIssuesStore } from '@/store/issues-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * The workspace's named statuses. Choosing one also moves the task to that
 * status's category, which is what the board and the review gate read.
 */
export function CustomStatusSelect({ issue }: { issue: Issue }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const [statuses, setStatuses] = useState<WorkspaceStatus[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      void loadStatuses(workspaceId)
         .then(setStatuses)
         .catch(() => setStatuses([]));
   }, [workspaceId]);

   if (!statuses.some((status) => !status.isSystem)) return null;

   return (
      <Select
         value={issue.statusId ?? ''}
         onValueChange={(statusId) =>
            void setCustomStatus(issue.identifier, statusId)
               .then((updated) => updateIssue(issue.id, updated))
               .catch((cause: unknown) => toast.error(describePatchFailure(cause)))
         }
      >
         <SelectTrigger className="h-7">
            <SelectValue placeholder="Named status" />
         </SelectTrigger>
         <SelectContent>
            {statuses.map((status) => (
               <SelectItem key={status.id} value={status.id}>
                  {status.name}
               </SelectItem>
            ))}
         </SelectContent>
      </Select>
   );
}
