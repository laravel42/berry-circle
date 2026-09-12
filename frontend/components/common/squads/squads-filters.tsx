'use client';

import { ArrowUpDown, Check, ChevronRight, Columns3, ListFilter } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
   CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Agent } from '@/lib/agents';

export const SQUAD_COLUMNS = ['leader', 'members', 'creator', 'updated'] as const;
export type SquadColumn = (typeof SQUAD_COLUMNS)[number];

export const SQUAD_SORTS = ['name', 'updated', 'members'] as const;
export type SquadSort = (typeof SQUAD_SORTS)[number];

export interface SquadCriteria {
   /** "Mine" is the squads this account made; "all" is the workspace's. */
   scope: 'all' | 'mine';
   leaderAgentId: string | null;
   createdBy: string | null;
   sort: SquadSort;
   columns: SquadColumn[];
}

export const DEFAULT_SQUAD_CRITERIA: SquadCriteria = {
   scope: 'all',
   leaderAgentId: null,
   createdBy: null,
   sort: 'name',
   columns: ['leader', 'members'],
};

export function activeSquadFilters(criteria: SquadCriteria): number {
   let count = 0;
   if (criteria.scope !== 'all') count += 1;
   if (criteria.leaderAgentId) count += 1;
   if (criteria.createdBy) count += 1;
   return count;
}

interface Props {
   criteria: SquadCriteria;
   onChange: (criteria: SquadCriteria) => void;
   agents: Agent[];
   creators: Array<{ id: string; name: string }>;
}

type Pane = 'leader' | 'creator' | null;

/** Scope, filters, sort and columns for the squad list. */
export default function SquadsFilters({ criteria, onChange, agents, creators }: Props) {
   const t = useTranslations('areas.squads');
   const [open, setOpen] = useState(false);
   const [pane, setPane] = useState<Pane>(null);
   const count = activeSquadFilters(criteria);
   const set = (patch: Partial<SquadCriteria>) => onChange({ ...criteria, ...patch });

   const back = (
      <Button variant="ghost" size="icon" className="size-6" onClick={() => setPane(null)}>
         <ChevronRight className="size-4 rotate-180" />
      </Button>
   );

   return (
      <div className="flex flex-wrap items-center gap-2">
         <div className="flex items-center gap-1 rounded-md border p-0.5">
            {(['all', 'mine'] as const).map((scope) => (
               <Button
                  key={scope}
                  size="xxs"
                  variant={criteria.scope === scope ? 'secondary' : 'ghost'}
                  onClick={() => set({ scope })}
               >
                  {t(`filters.${scope}`)}
               </Button>
            ))}
         </div>

         <Popover
            open={open}
            onOpenChange={(next) => {
               setOpen(next);
               if (!next) setPane(null);
            }}
         >
            <PopoverTrigger asChild>
               <Button size="xs" variant="ghost" className="relative">
                  <ListFilter className="mr-1 size-4" />
                  {t('filters.button')}
                  {count > 0 ? (
                     <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        {count}
                     </span>
                  ) : null}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
               {pane === null ? (
                  <Command>
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              onSelect={() => setPane('leader')}
                              className="justify-between"
                           >
                              {t('filters.leader')}
                              <ChevronRight className="size-4" />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => setPane('creator')}
                              className="justify-between"
                           >
                              {t('filters.creator')}
                              <ChevronRight className="size-4" />
                           </CommandItem>
                        </CommandGroup>
                        {count > 0 ? (
                           <>
                              <CommandSeparator />
                              <CommandGroup>
                                 <CommandItem
                                    onSelect={() =>
                                       set({ scope: 'all', leaderAgentId: null, createdBy: null })
                                    }
                                 >
                                    {t('filters.clear')}
                                 </CommandItem>
                              </CommandGroup>
                           </>
                        ) : null}
                     </CommandList>
                  </Command>
               ) : pane === 'leader' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.leader')}</span>
                     </div>
                     <CommandInput placeholder={t('filters.searchAgents')} />
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              onSelect={() => set({ leaderAgentId: null })}
                              className="justify-between"
                           >
                              {t('filters.anyLeader')}
                              {criteria.leaderAgentId === null ? (
                                 <Check className="size-4" />
                              ) : null}
                           </CommandItem>
                           {agents.map((agent) => (
                              <CommandItem
                                 key={agent.id}
                                 value={agent.name}
                                 onSelect={() => set({ leaderAgentId: agent.id })}
                                 className="justify-between"
                              >
                                 {agent.name}
                                 {criteria.leaderAgentId === agent.id ? (
                                    <Check className="size-4" />
                                 ) : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               ) : (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.creator')}</span>
                     </div>
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              onSelect={() => set({ createdBy: null })}
                              className="justify-between"
                           >
                              {t('filters.anyCreator')}
                              {criteria.createdBy === null ? <Check className="size-4" /> : null}
                           </CommandItem>
                           {creators.map((creator) => (
                              <CommandItem
                                 key={creator.id}
                                 value={creator.name}
                                 onSelect={() => set({ createdBy: creator.id })}
                                 className="justify-between"
                              >
                                 {creator.name}
                                 {criteria.createdBy === creator.id ? (
                                    <Check className="size-4" />
                                 ) : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               )}
            </PopoverContent>
         </Popover>

         <Popover>
            <PopoverTrigger asChild>
               <Button size="xs" variant="ghost">
                  <ArrowUpDown className="mr-1 size-4" />
                  {t(`filters.sort_${criteria.sort}`)}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-0" align="start">
               <Command>
                  <CommandList>
                     <CommandGroup>
                        {SQUAD_SORTS.map((sort) => (
                           <CommandItem
                              key={sort}
                              onSelect={() => set({ sort })}
                              className="justify-between"
                           >
                              {t(`filters.sort_${sort}`)}
                              {criteria.sort === sort ? <Check className="size-4" /> : null}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>

         <Popover>
            <PopoverTrigger asChild>
               <Button size="xs" variant="ghost">
                  <Columns3 className="mr-1 size-4" />
                  {t('filters.columns')}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-0" align="start">
               <Command>
                  <CommandList>
                     <CommandGroup>
                        {SQUAD_COLUMNS.map((column) => (
                           <CommandItem
                              key={column}
                              onSelect={() =>
                                 set({
                                    columns: criteria.columns.includes(column)
                                       ? criteria.columns.filter((entry) => entry !== column)
                                       : [...criteria.columns, column],
                                 })
                              }
                              className="justify-between"
                           >
                              {t(`columns.${column}`)}
                              {criteria.columns.includes(column) ? (
                                 <Check className="size-4" />
                              ) : null}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>
      </div>
   );
}
