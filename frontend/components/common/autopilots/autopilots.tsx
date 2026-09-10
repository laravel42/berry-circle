'use client';

import { Badge } from '@/components/ui/badge';
import { useAutopilots } from '@/hooks/use-autopilots';
import type { Autopilot } from '@/lib/autopilots';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useAgentsStore } from '@/store/agents-store';
import Link from 'next/link';
import { useParams } from 'next/navigation';

function modeLabel(autopilot: Autopilot): string {
   return autopilot.executionMode === 'create_issue' ? 'new task per run' : 'one standing task';
}

export default function Autopilots() {
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId || WORKSPACE_SLUG;
   const { autopilots, error, loaded } = useAutopilots();
   // Select the stable array, not a new closure: a selector that returns a
   // fresh function on every call re-renders forever under zustand.
   const agents = useAgentsStore((state) => state.agents);
   const agentName = (id: string) => agents.find((agent) => agent.id === id)?.name ?? 'an agent';

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Autopilot</div>
            <div className="w-24 shrink-0">Status</div>
            <div className="hidden w-44 shrink-0 md:block">Quota</div>
            <div className="hidden w-28 shrink-0 sm:block">Updated</div>
         </div>
         {!loaded && !error ? (
            <div className="px-6 py-10 text-muted-foreground">Loading autopilots…</div>
         ) : error ? (
            <div className="px-6 py-10 text-muted-foreground" role="alert">
               {error}
            </div>
         ) : autopilots.length === 0 ? (
            <div className="px-6 py-12 text-muted-foreground">
               No autopilots yet. An autopilot hands an agent the same prompt on a schedule, on a
               webhook, or whenever you press run.
            </div>
         ) : (
            autopilots.map((autopilot) => (
               <Link
                  key={autopilot.id}
                  href={`/${orgId}/autopilot/${autopilot.id}`}
                  className="flex items-center border-b px-6 py-2.5 hover:bg-accent/40"
               >
                  <div className="min-w-0 flex-1">
                     <div className="truncate font-medium">{autopilot.name}</div>
                     <div className="truncate text-muted-foreground">
                        {agentName(autopilot.assigneeId)} · {modeLabel(autopilot)}
                     </div>
                  </div>
                  <div className="w-24 shrink-0">
                     <Badge variant={autopilot.status === 'active' ? 'default' : 'secondary'}>
                        {autopilot.status}
                     </Badge>
                  </div>
                  <div className="hidden w-44 shrink-0 text-muted-foreground md:block">
                     {autopilot.quotaPeriod === 'none'
                        ? 'no limit'
                        : `${autopilot.quotaMax ?? 0} per ${autopilot.quotaPeriod}`}
                  </div>
                  <div className="hidden w-28 shrink-0 text-muted-foreground sm:block">
                     {new Date(autopilot.updatedAt).toLocaleDateString()}
                  </div>
               </Link>
            ))
         )}
      </div>
   );
}
