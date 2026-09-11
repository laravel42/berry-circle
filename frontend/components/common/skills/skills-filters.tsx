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
import type { Skill } from '@/lib/skills';

export const SKILL_COLUMNS = ['source', 'agents', 'files', 'creator', 'updated'] as const;
export type SkillColumn = (typeof SKILL_COLUMNS)[number];

export const SKILL_SORTS = ['name', 'updated', 'usage'] as const;
export type SkillSort = (typeof SKILL_SORTS)[number];

export interface SkillCriteria {
   usage: 'all' | 'inUse' | 'unused';
   origin: Skill['source']['kind'] | 'all';
   agentId: string | null;
   createdBy: string | null;
   sort: SkillSort;
   columns: SkillColumn[];
}

export const DEFAULT_CRITERIA: SkillCriteria = {
   usage: 'all',
   origin: 'all',
   agentId: null,
   createdBy: null,
   sort: 'name',
   columns: ['source', 'agents', 'files'],
};

export function activeFilterCount(criteria: SkillCriteria): number {
   let count = 0;
   if (criteria.usage !== 'all') count += 1;
   if (criteria.origin !== 'all') count += 1;
   if (criteria.agentId) count += 1;
   if (criteria.createdBy) count += 1;
   return count;
}

interface Props {
   criteria: SkillCriteria;
   onChange: (criteria: SkillCriteria) => void;
   agents: Agent[];
   /** Everyone who has made a skill here, as the list itself reports them. */
   creators: Array<{ id: string; name: string }>;
}

type Pane = 'usage' | 'origin' | 'agent' | 'creator' | null;

/**
 * The catalogue's filter, sort and column controls.
 *
 * One popover with panes rather than four separate menus, the way the members
 * list does it, so the header stays readable at a narrow width.
 */
export default function SkillsFilters({ criteria, onChange, agents, creators }: Props) {
   const t = useTranslations('areas.skills');
   const [open, setOpen] = useState(false);
   const [pane, setPane] = useState<Pane>(null);
   const count = activeFilterCount(criteria);

   const set = (patch: Partial<SkillCriteria>) => onChange({ ...criteria, ...patch });
   const back = (
      <Button variant="ghost" size="icon" className="size-6" onClick={() => setPane(null)}>
         <ChevronRight className="size-4 rotate-180" />
      </Button>
   );

   return (
      <div className="flex flex-wrap items-center gap-2">
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
                              onSelect={() => setPane('usage')}
                              className="justify-between"
                           >
                              {t('filters.usage')}
                              <ChevronRight className="size-4" />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => setPane('origin')}
                              className="justify-between"
                           >
                              {t('filters.origin')}
                              <ChevronRight className="size-4" />
                           </CommandItem>
                           <CommandItem
                              onSelect={() => setPane('agent')}
                              className="justify-between"
                           >
                              {t('filters.agent')}
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
                                       set({
                                          usage: 'all',
                                          origin: 'all',
                                          agentId: null,
                                          createdBy: null,
                                       })
                                    }
                                 >
                                    {t('filters.clear')}
                                 </CommandItem>
                              </CommandGroup>
                           </>
                        ) : null}
                     </CommandList>
                  </Command>
               ) : pane === 'usage' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.usage')}</span>
                     </div>
                     <CommandList>
                        <CommandGroup>
                           {(['all', 'inUse', 'unused'] as const).map((value) => (
                              <CommandItem
                                 key={value}
                                 onSelect={() => set({ usage: value })}
                                 className="justify-between"
                              >
                                 {value === 'all'
                                    ? t('filters.any')
                                    : value === 'inUse'
                                      ? t('filters.inUse')
                                      : t('filters.unused')}
                                 {criteria.usage === value ? <Check className="size-4" /> : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               ) : pane === 'origin' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.origin')}</span>
                     </div>
                     <CommandList>
                        <CommandGroup>
                           {(['all', 'manual', 'github', 'zip'] as const).map((value) => (
                              <CommandItem
                                 key={value}
                                 onSelect={() => set({ origin: value })}
                                 className="justify-between"
                              >
                                 {value === 'all' ? t('filters.any') : t(`source.${value}`)}
                                 {criteria.origin === value ? <Check className="size-4" /> : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               ) : pane === 'agent' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.agent')}</span>
                     </div>
                     <CommandInput placeholder={t('filters.searchAgents')} />
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              onSelect={() => set({ agentId: null })}
                              className="justify-between"
                           >
                              {t('filters.anyAgent')}
                              {criteria.agentId === null ? <Check className="size-4" /> : null}
                           </CommandItem>
                           {agents.map((agent) => (
                              <CommandItem
                                 key={agent.id}
                                 value={agent.name}
                                 onSelect={() => set({ agentId: agent.id })}
                                 className="justify-between"
                              >
                                 {agent.name}
                                 {criteria.agentId === agent.id ? (
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
                        {SKILL_SORTS.map((sort) => (
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
                        {SKILL_COLUMNS.map((column) => (
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
