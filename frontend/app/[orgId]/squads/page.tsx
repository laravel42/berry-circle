'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';

import SquadCreateDialog from '@/components/common/squads/squad-create-dialog';
import SquadsFilters, {
   DEFAULT_SQUAD_CRITERIA,
   activeSquadFilters,
   type SquadCriteria,
} from '@/components/common/squads/squads-filters';
import SquadsList from '@/components/common/squads/squads-list';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { User } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { loadWorkspaceMembers } from '@/lib/members';
import { listSquads, type Squad } from '@/lib/squads';
import { canEditProduct } from '@/lib/workspace-role';
import { useSessionStore } from '@/store/session-store';

export default function SquadsPage() {
   const t = useTranslations('areas.squads');
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const role = useSessionStore((state) => state.workspace?.role);
   const me = useSessionStore((state) => state.user?.id ?? null);
   const canEdit = canEditProduct(role);

   const [squads, setSquads] = useState<Squad[] | null>(null);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [people, setPeople] = useState<User[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [query, setQuery] = useState('');
   const [criteria, setCriteria] = useState<SquadCriteria>(DEFAULT_SQUAD_CRITERIA);
   const [creating, setCreating] = useState(false);
   const [version, setVersion] = useState(0);
   const reload = useCallback(() => setVersion((current) => current + 1), []);

   useEffect(() => {
      let cancelled = false;
      listSquads()
         .then((found) => {
            if (cancelled) return;
            setSquads(found);
            setError(null);
         })
         .catch((failure: unknown) => {
            if (!cancelled) {
               setError(failure instanceof BerryApiError ? failure.message : t('loadFailed'));
            }
         });
      void loadWorkspaceAgents().then(
         (found) => {
            if (!cancelled) setAgents(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [version, t]);

   useEffect(() => {
      if (!workspaceId) return;
      let cancelled = false;
      void loadWorkspaceMembers(workspaceId).then(
         (found) => {
            if (!cancelled) setPeople(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, [workspaceId]);

   /** Squads are few and the list arrives whole, so narrowing happens here. */
   const shown = useMemo(() => {
      const needle = query.trim().toLowerCase();
      return (squads ?? []).filter((squad) => {
         if (needle && !`${squad.name} ${squad.description}`.toLowerCase().includes(needle)) {
            return false;
         }
         if (criteria.scope === 'mine' && squad.createdBy !== me) return false;
         if (criteria.leaderAgentId && squad.leaderAgentId !== criteria.leaderAgentId) return false;
         if (criteria.createdBy && squad.createdBy !== criteria.createdBy) return false;
         return true;
      });
   }, [squads, query, criteria, me]);

   const creators = useMemo(() => {
      const seen = new Set<string>();
      for (const squad of squads ?? []) if (squad.createdBy) seen.add(squad.createdBy);
      return [...seen].map((id) => ({
         id,
         name: people.find((person) => person.id === id)?.name ?? t('row.someone'),
      }));
   }, [squads, people, t]);

   const header = (
      <div className="flex w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">{t('subtitle')}</p>
            </div>
            {canEdit ? (
               <Button size="xs" variant="secondary" onClick={() => setCreating(true)}>
                  {t('new')}
               </Button>
            ) : null}
         </div>
         <div className="flex flex-wrap items-center gap-2">
            <Input
               value={query}
               onChange={(event) => setQuery(event.target.value)}
               placeholder={t('search')}
               aria-label={t('search')}
               className="h-7 max-w-xs"
            />
            <SquadsFilters
               criteria={criteria}
               onChange={setCriteria}
               agents={agents}
               creators={creators}
            />
         </div>
      </div>
   );

   return (
      <MainLayout header={header}>
         <SquadsList
            squads={squads === null ? null : shown}
            error={error}
            criteria={criteria}
            agents={agents}
            canEdit={canEdit}
            onChanged={reload}
            narrowed={query.trim() !== '' || activeSquadFilters(criteria) > 0}
         />
         <SquadCreateDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={reload}
            agents={agents}
            people={people}
         />
      </MainLayout>
   );
}
