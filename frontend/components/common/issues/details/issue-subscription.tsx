'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { loadSubscribers, setSubscription, type Subscriber } from '@/lib/subscribers';
import { Bell, BellOff, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

/** Follow a task (and optionally its sub-tasks) so its changes reach the inbox. */
export function IssueSubscription({ issueRef }: { issueRef: string }) {
   const [state, setState] = useState<{ nodes: Subscriber[]; subscribed: boolean }>({ nodes: [], subscribed: false });

   const reload = useCallback(() => {
      void loadSubscribers(issueRef)
         .then(setState)
         .catch(() => undefined);
   }, [issueRef]);
   useEffect(reload, [reload]);

   const change = (subscribed: boolean, subtree: boolean) =>
      void setSubscription(issueRef, subscribed, subtree)
         .then(reload)
         .catch(() => toast.error('The subscription could not be changed.'));

   return (
      <div className="flex items-center gap-1">
         <Button variant="outline" size="sm" onClick={() => change(!state.subscribed, false)}>
            {state.subscribed ? <BellOff className="mr-1 size-3.5" /> : <Bell className="mr-1 size-3.5" />}
            {state.subscribed ? 'Unsubscribe' : 'Subscribe'}
         </Button>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button variant="ghost" size="icon" className="size-8" aria-label="Subscription options">
                  <ChevronDown className="size-3.5" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               <DropdownMenuItem onClick={() => change(true, true)}>Subscribe to all sub-tasks</DropdownMenuItem>
               <DropdownMenuItem onClick={() => change(false, true)}>Unsubscribe from all sub-tasks</DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
         <span className="text-muted-foreground">{state.nodes.length} following</span>
      </div>
   );
}
