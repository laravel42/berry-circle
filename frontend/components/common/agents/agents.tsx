'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUpDown } from 'lucide-react';

import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, pickRunnableAgent, type Agent } from '@/lib/agents';
import { useAgentsListStore } from '@/store/agents-list-store';
import { useAgentsStore } from '@/store/agents-store';
import { useRunsStore } from '@/store/runs-store';
import AgentLine from './agent-line';

function countRunsByAgent(agentIds: string[], runs: { agentId: string }[]): Map<string, number> {
   const allowed = new Set(agentIds);
   const counts = new Map<string, number>();
   for (const run of runs) {
      if (!allowed.has(run.agentId)) continue;
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
   }
   return counts;
}

export default function Agents() {
   const storedAgents = useAgentsStore((state) => state.agents);
   const storedError = useAgentsStore((state) => state.error);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const runs = useRunsStore((state) => state.runs);
   const { search, sort } = useAgentsListStore();

   const [loading, setLoading] = useState(storedAgents.length === 0 && !storedError);

   const runCounts = useMemo(
      () => countRunsByAgent(storedAgents.map((agent) => agent.id), runs),
      [storedAgents, runs]
   );

   useEffect(() => {
      if (storedAgents.length > 0 || storedError) {
         setLoading(false);
         return;
      }
      let cancelled = false;
      void loadWorkspaceAgents()
         .then((agents) => {
            if (!cancelled) {
               hydrateAgents(agents, null);
               setLoading(false);
            }
         })
         .catch((error: unknown) => {
            if (!cancelled) {
               hydrateAgents(
                  [],
                  error instanceof BerryApiError ? error.message : 'Agent runtime is unavailable.'
               );
               setLoading(false);
            }
         });
      return () => {
         cancelled = true;
      };
   }, [storedAgents.length, storedError, hydrateAgents]);

   const featuredAgentId = pickRunnableAgent(storedAgents)?.id;

   const displayed = useMemo(() => {
      let list: Agent[] = storedAgents.slice();
      const query = search.trim().toLowerCase();

      if (query) {
         list = list.filter(
            (agent) =>
               agent.name.toLowerCase().includes(query) ||
               (agent.description ?? '').toLowerCase().includes(query)
         );
      }

      list.sort((left, right) => {
         if (sort === 'name-asc') {
            return left.name.localeCompare(right.name);
         }
         return right.updatedAt.localeCompare(left.updatedAt);
      });

      return list;
   }, [storedAgents, search, sort]);

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">Agent</div>
            <div className="w-[110px] shrink-0">Status</div>
            <div className="hidden w-[100px] shrink-0 lg:block">Access</div>
            <div className="hidden w-[180px] shrink-0 xl:block">Model</div>
            <div className="hidden w-[110px] shrink-0 sm:flex sm:items-center sm:gap-1">
               Last active
               {sort === 'last-active-desc' ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3" />}
            </div>
            <div className="w-[56px] shrink-0 text-right">Runtimes</div>
         </div>

         {loading ? (
            <div className="px-6 py-10 text-muted-foreground">Loading agents…</div>
         ) : storedError ? (
            <div className="px-6 py-10 text-muted-foreground">{storedError}</div>
         ) : displayed.length === 0 ? (
            <div className="px-6 py-10 text-muted-foreground">
               {search.trim()
                  ? 'No agents match your search.'
                  : 'No agents are registered for this workspace yet.'}
            </div>
         ) : (
            displayed.map((agent) => (
               <AgentLine
                  key={agent.id}
                  agent={agent}
                  runCount={runCounts.get(agent.id) ?? 0}
                  highlightYou={agent.id === featuredAgentId}
               />
            ))
         )}
      </div>
   );
}
