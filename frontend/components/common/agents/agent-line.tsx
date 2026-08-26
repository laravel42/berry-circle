'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { BerryMark } from '@/components/brand/berry-mark';
import { cn } from '@/lib/utils';
import {
   agentModelDisplay,
   agentPriceDisplay,
   agentStatusDisplay,
   type Agent,
   type AgentModel,
} from '@/lib/agents';

interface AgentLineProps {
   agent: Agent;
   runCount: number;
   /** Catalog models keyed by provider/id, for the price cell. */
   prices: Map<string, AgentModel>;
   highlightYou?: boolean;
}

export default function AgentLine({
   agent,
   runCount,
   prices,
   highlightYou = false,
}: AgentLineProps) {
   const { orgId } = useParams<{ orgId: string }>();
   const status = agentStatusDisplay(agent.status);
   const model = agentModelDisplay(agent);
   const price = agentPriceDisplay(agent, prices);

   return (
      <Link
         href={`/${orgId}/agents/${agent.id}`}
         className="flex w-full items-center border-b border-muted-foreground/5 px-6 py-3 last:border-b-0 hover:bg-sidebar/50"
      >
         <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted/40">
               <BerryMark size="sm" tone="working" label={agent.name} />
            </span>
            <div className="min-w-0 overflow-hidden">
               <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium leading-none">{agent.name}</span>
                  {highlightYou ? (
                     <span className="shrink-0 rounded border border-border px-1.5 py-px uppercase tracking-wide text-muted-foreground">
                        You
                     </span>
                  ) : null}
               </div>
               {agent.description ? (
                  <p className="mt-0.5 line-clamp-2 text-muted-foreground">{agent.description}</p>
               ) : null}
            </div>
         </div>

         <div className="w-27.5 shrink-0">
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
               <span
                  className={cn(
                     'size-1.5 rounded-full',
                     status.tone === 'online' && 'bg-[#00cc66]',
                     status.tone === 'busy' && 'bg-amber-500',
                     status.tone === 'offline' && 'bg-muted-foreground/40',
                     status.tone === 'unknown' && 'bg-muted-foreground/40'
                  )}
               />
               {status.label}
            </span>
         </div>

         <div className="hidden w-25 shrink-0 text-muted-foreground lg:block">Workspace</div>

         <div
            className="hidden w-45 shrink-0 truncate text-muted-foreground xl:block"
            title={model.title}
         >
            {model.label}
         </div>

         <div
            className="hidden w-27.5 shrink-0 tabular-nums text-muted-foreground sm:block"
            title={price.title}
         >
            {price.label}
         </div>

         <div className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
            {runCount}
         </div>
      </Link>
   );
}
