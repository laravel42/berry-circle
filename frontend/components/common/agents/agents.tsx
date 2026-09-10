'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { BerryApiError } from '@/lib/api';
import {
   listAgentModels,
   loadArchivedAgents,
   loadWorkspaceAgents,
   modelKey,
   pickRunnableAgent,
   type Agent,
   type AgentModel,
} from '@/lib/agents';
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
   const t = useTranslations('agents.list');
   const storedAgents = useAgentsStore((state) => state.agents);
   const storedError = useAgentsStore((state) => state.error);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const runs = useRunsStore((state) => state.runs);
   const { search, sort, showArchived } = useAgentsListStore();
   const [archived, setArchived] = useState<Agent[] | null>(null);
   const [archivedError, setArchivedError] = useState<string | null>(null);

   // Archived agents are loaded on demand: the live roster stays in the store,
   // and the archive is a view onto it the person asked for.
   useEffect(() => {
      if (!showArchived) return;
      let cancelled = false;
      setArchived(null);
      setArchivedError(null);
      void loadArchivedAgents()
         .then((agents) => {
            if (!cancelled) setArchived(agents);
         })
         .catch((error: unknown) => {
            if (!cancelled) {
               setArchivedError(
                  error instanceof BerryApiError ? error.message : t('archivedLoadFailed')
               );
            }
         });
      return () => {
         cancelled = true;
      };
   }, [showArchived, t]);

   const [loading, setLoading] = useState(storedAgents.length === 0 && !storedError);
   const [prices, setPrices] = useState<Map<string, AgentModel>>(new Map());

   // The catalog, not the agent, knows what a model costs. Best effort on
   // purpose: a catalog Berry cannot reach costs the list its price column,
   // which is not a reason to withhold the agents.
   useEffect(() => {
      let cancelled = false;
      void listAgentModels()
         .then((models) => {
            if (cancelled) return;
            setPrices(new Map(models.map((model) => [modelKey(model), model])));
         })
         .catch(() => {
            /* leaves every price a dash */
         });
      return () => {
         cancelled = true;
      };
   }, []);

   const runCounts = useMemo(
      () =>
         countRunsByAgent(
            storedAgents.map((agent) => agent.id),
            runs
         ),
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
      let list: Agent[] = (showArchived ? (archived ?? []) : storedAgents).slice();
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
   }, [storedAgents, archived, showArchived, search, sort]);

   const listLoading = showArchived ? archived === null && !archivedError : loading;
   const listError = showArchived ? archivedError : storedError;

   return (
      <div className="w-full">
         <div className="sticky top-0 z-10 flex items-center border-b bg-container px-6 py-1.5 text-muted-foreground">
            <div className="min-w-0 flex-1">{t('agent')}</div>
            <div className="w-27.5 shrink-0">{t('status')}</div>
            <div className="hidden w-25 shrink-0 lg:block">{t('access')}</div>
            <div className="hidden w-45 shrink-0 xl:block">{t('model')}</div>
            <div className="hidden w-27.5 shrink-0 sm:block" title={t('priceHint')}>
               {t('price')}
            </div>
            <div className="w-14 shrink-0 text-right">{t('runtimes')}</div>
         </div>

         {listLoading ? (
            <div className="px-6 py-10 text-muted-foreground">{t('loading')}</div>
         ) : listError ? (
            <div className="px-6 py-10 text-muted-foreground">{listError}</div>
         ) : displayed.length === 0 ? (
            <div className="px-6 py-10 text-muted-foreground">
               {search.trim() ? t('noMatch') : showArchived ? t('noArchived') : t('none')}
            </div>
         ) : (
            displayed.map((agent) => (
               <AgentLine
                  key={agent.id}
                  agent={agent}
                  runCount={runCounts.get(agent.id) ?? 0}
                  prices={prices}
                  highlightYou={agent.id === featuredAgentId}
               />
            ))
         )}
      </div>
   );
}
