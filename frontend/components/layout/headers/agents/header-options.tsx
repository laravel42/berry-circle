'use client';

import { ArrowDown, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAgentsListStore, type AgentsSort } from '@/store/agents-list-store';

export default function HeaderOptions() {
   const t = useTranslations('agents.options');
   const { search, sort, setSearch, setSort } = useAgentsListStore();

   const toggleSort = () => {
      const next: AgentsSort = sort === 'last-active-desc' ? 'name-asc' : 'last-active-desc';
      setSort(next);
   };

   return (
      <div className="flex h-10 w-full items-center justify-between gap-3 border-b px-6 py-1.5">
         <div className="flex min-w-0 flex-1 items-center gap-3">
            <Input
               value={search}
               onChange={(event) => setSearch(event.target.value)}
               placeholder={t('searchPlaceholder')}
               className="h-7 max-w-xs border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-foreground/40"
               aria-label={t('searchLabel')}
            />
         </div>
         <div className="flex shrink-0 items-center gap-2">
            <Button size="xs" variant="secondary" disabled>
               <SlidersHorizontal className="mr-1 size-4" />
               {t('filter')}
            </Button>
            <Button size="xs" variant="secondary" onClick={toggleSort}>
               {sort === 'last-active-desc' ? t('sortLastActive') : t('sortName')}
               <ArrowDown className="ml-1 size-4" />
            </Button>
         </div>
      </div>
   );
}
