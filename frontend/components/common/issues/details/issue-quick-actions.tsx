'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BerryApiError } from '@/lib/api';
import { runQuickAction } from '@/lib/issue-tracking';
import { loadQuickActions, type QuickAction } from '@/lib/quick-actions';
import { useSessionStore } from '@/store/session-store';
import { Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Run a saved prompt on this task as an agent task. */
export function IssueQuickActions({ issueRef }: { issueRef: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [actions, setActions] = useState<QuickAction[]>([]);

   useEffect(() => {
      if (!workspaceId) return;
      void loadQuickActions(workspaceId)
         .then(setActions)
         .catch(() => setActions([]));
   }, [workspaceId]);

   if (actions.length === 0) return null;

   const run = (action: QuickAction) =>
      void runQuickAction(issueRef, action.id)
         .then(() => toast.success(`${action.name} started`))
         .catch((cause: unknown) =>
            toast.error(
               cause instanceof BerryApiError && cause.status === 503
                  ? 'Agent runtime is not available on this server.'
                  : `${action.name} could not start.`
            )
         );

   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
               <Zap className="mr-1 size-3.5" />
               Quick action
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="end">
            {actions.map((action) => (
               <DropdownMenuItem key={action.id} onClick={() => run(action)}>
                  {action.name}
               </DropdownMenuItem>
            ))}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
