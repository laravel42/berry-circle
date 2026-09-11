'use client';

import { X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import NewSkillDialog from '@/components/common/skills/new-skill-dialog';
import SkillDetail from '@/components/common/skills/skill-detail';
import SkillsFilters, {
   DEFAULT_CRITERIA,
   activeFilterCount,
   type SkillCriteria,
} from '@/components/common/skills/skills-filters';
import SkillsList from '@/components/common/skills/skills-list';
import MainLayout from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents, type Agent } from '@/lib/agents';
import { listSkills, type Skill } from '@/lib/skills';
import { canEditProduct } from '@/lib/workspace-role';
import { useSessionStore } from '@/store/session-store';

function SkillsScreen() {
   const t = useTranslations('areas.skills');
   const router = useRouter();
   const params = useSearchParams();
   const view = params.get('view');
   const role = useSessionStore((state) => state.workspace?.role);
   const canEdit = canEditProduct(role);

   const [query, setQuery] = useState('');
   const [criteria, setCriteria] = useState<SkillCriteria>(DEFAULT_CRITERIA);
   const [skills, setSkills] = useState<Skill[] | null>(null);
   const [agents, setAgents] = useState<Agent[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [creating, setCreating] = useState(false);
   const [version, setVersion] = useState(0);
   const reload = useCallback(() => setVersion((current) => current + 1), []);

   useEffect(() => {
      let cancelled = false;
      void loadWorkspaceAgents()
         .then((found) => {
            if (!cancelled) setAgents(found);
         })
         .catch(() => {
            /* The catalogue is still usable without the agent list. */
         });
      return () => {
         cancelled = true;
      };
   }, []);

   // The server answers the filters it knows (search, origin, agent, creator,
   // usage); sort and columns are the reader's own view of the same answer.
   useEffect(() => {
      let cancelled = false;
      const timer = setTimeout(() => {
         listSkills({
            ...(query.trim() ? { q: query.trim() } : {}),
            ...(criteria.origin === 'all' ? {} : { source: criteria.origin }),
            ...(criteria.agentId ? { agentId: criteria.agentId } : {}),
            ...(criteria.createdBy ? { createdBy: criteria.createdBy } : {}),
            ...(criteria.usage === 'all' ? {} : { inUse: criteria.usage === 'inUse' }),
         })
            .then((found) => {
               if (cancelled) return;
               setSkills(found);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (cancelled) return;
               setError(failure instanceof BerryApiError ? failure.message : t('loadFailed'));
            });
      }, 200);
      return () => {
         cancelled = true;
         clearTimeout(timer);
      };
   }, [query, criteria, version, t]);

   /** Who has made a skill here, as the catalogue itself reports it. */
   const creators = useMemo(() => {
      const seen = new Map<string, string>();
      for (const skill of skills ?? []) {
         if (skill.createdBy) seen.set(skill.createdBy, skill.creatorName ?? skill.createdBy);
      }
      return [...seen].map(([id, name]) => ({ id, name }));
   }, [skills]);

   const open = (id: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (id) next.set('view', id);
      else next.delete('view');
      router.replace(`?${next.toString()}`, { scroll: false });
   };

   const header = (
      <div className="flex w-full flex-col gap-2 border-b px-6 py-3">
         <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
               <span className="font-medium">{t('title')}</span>
               <p className="mt-1 max-w-2xl text-muted-foreground">{t('subtitle')}</p>
            </div>
            {canEdit ? (
               <Button size="xs" variant="secondary" onClick={() => setCreating(true)}>
                  {t('create.title')}
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
            <SkillsFilters
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
         <div className="flex h-full min-h-0 w-full">
            <div className={view ? 'hidden min-w-0 flex-1 lg:block' : 'min-w-0 flex-1'}>
               <SkillsList
                  skills={skills}
                  error={error}
                  criteria={criteria}
                  agents={agents}
                  canEdit={canEdit}
                  openId={view}
                  onOpen={(id) => open(id)}
                  onChanged={reload}
                  narrowed={query.trim() !== '' || activeFilterCount(criteria) > 0}
               />
            </div>
            {view ? (
               <aside className="flex min-w-0 flex-1 flex-col border-l lg:max-w-2xl">
                  <div className="flex justify-end px-3 pt-2">
                     <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        aria-label={t('detail.close')}
                        onClick={() => open(null)}
                     >
                        <X className="size-4" />
                     </Button>
                  </div>
                  <SkillDetail
                     key={view}
                     skillId={view}
                     canEdit={canEdit}
                     onChanged={reload}
                     onClose={() => open(null)}
                  />
               </aside>
            ) : null}
         </div>
         <NewSkillDialog
            open={creating}
            onOpenChange={setCreating}
            onCreated={(skill) => {
               reload();
               open(skill.id);
            }}
            existingNames={(skills ?? []).map((skill) => skill.name)}
         />
      </MainLayout>
   );
}

export default function SkillsPage() {
   return (
      <Suspense>
         <SkillsScreen />
      </Suspense>
   );
}
