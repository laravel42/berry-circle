'use client';

import { ArrowDown, SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAgentsListStore, type AgentsSort, type AgentsTab } from '@/store/agents-list-store';

const TABS: { value: AgentsTab; label: string }[] = [
   { value: 'mine', label: 'Mine' },
   { value: 'all', label: 'All' },
   { value: 'archived', label: 'Archived' },
];

export default function HeaderOptions() {
   const { search, tab, sort, tabCounts, setSearch, setTab, setSort } = useAgentsListStore();

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
               placeholder="Search agents…"
               className="h-7 max-w-xs border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-foreground/40"
               aria-label="Search agents"
            />
            <div className="hidden items-center gap-1 sm:flex">
               {TABS.map((item) => {
                  const count = tabCounts[item.value];
                  return (
                     <button
                        key={item.value}
                        type="button"
                        onClick={() => setTab(item.value)}
                        className={cn(
                           'inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors',
                           tab === item.value
                              ? 'bg-accent text-foreground'
                              : 'text-muted-foreground hover:text-foreground'
                        )}
                     >
                        {item.label}
                        <span className="text-muted-foreground">{count}</span>
                     </button>
                  );
               })}
            </div>
         </div>
         <div className="flex shrink-0 items-center gap-2">
            <Button size="xs" variant="secondary" disabled>
               <SlidersHorizontal className="mr-1 size-4" />
               Filter
            </Button>
            <Button size="xs" variant="secondary" onClick={toggleSort}>
               {sort === 'last-active-desc' ? 'Last active' : 'Name'}
               <ArrowDown className="ml-1 size-4" />
            </Button>
         </div>
      </div>
   );
}
