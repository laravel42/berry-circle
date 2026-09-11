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

export const AUTOPILOT_COLUMNS = ['status', 'mode', 'quota', 'updated'] as const;
export type AutopilotColumn = (typeof AUTOPILOT_COLUMNS)[number];

export const AUTOPILOT_SORTS = ['name', 'updated', 'created'] as const;
export type AutopilotSort = (typeof AUTOPILOT_SORTS)[number];

export interface AutopilotCriteria {
   scope: 'all' | 'active' | 'paused';
   assigneeId: string | null;
   mode: 'all' | 'create_issue' | 'fixed_issue';
   trigger: 'all' | 'cron' | 'webhook' | 'none';
   createdBy: string | null;
   sort: AutopilotSort;
   columns: AutopilotColumn[];
}

export const DEFAULT_AUTOPILOT_CRITERIA: AutopilotCriteria = {
   scope: 'all',
   assigneeId: null,
   mode: 'all',
   trigger: 'all',
   createdBy: null,
   sort: 'name',
   columns: ['status', 'mode', 'updated'],
};

export function activeAutopilotFilters(criteria: AutopilotCriteria): number {
   let count = 0;
   if (criteria.assigneeId) count += 1;
   if (criteria.mode !== 'all') count += 1;
   if (criteria.trigger !== 'all') count += 1;
   if (criteria.createdBy) count += 1;
   return count;
}

interface Props {
   criteria: AutopilotCriteria;
   onChange: (criteria: AutopilotCriteria) => void;
   /** Agents and squads together: either can be an autopilot's assignee. */
   assignees: Array<{ id: string; name: string }>;
   creators: Array<{ id: string; name: string }>;
}

type Pane = 'assignee' | 'mode' | 'trigger' | 'creator' | null;

/** Scope, filters, sort and columns for the autopilot list. */
export default function AutopilotsFilters({ criteria, onChange, assignees, creators }: Props) {
   const t = useTranslations('areas.autopilots');
   const [open, setOpen] = useState(false);
   const [pane, setPane] = useState<Pane>(null);
   const count = activeAutopilotFilters(criteria);
   const set = (patch: Partial<AutopilotCriteria>) => onChange({ ...criteria, ...patch });

   const back = (
      <Button variant="ghost" size="icon" className="size-6" onClick={() => setPane(null)}>
         <ChevronRight className="size-4 rotate-180" />
      </Button>
   );

   return (
      <div className="flex flex-wrap items-center gap-2">
         <div className="flex items-center gap-1 rounded-md border p-0.5">
            {(['all', 'active', 'paused'] as const).map((scope) => (
               <Button
                  key={scope}
                  size="xxs"
                  variant={criteria.scope === scope ? 'secondary' : 'ghost'}
                  onClick={() => set({ scope })}
               >
                  {t(`filters.scope_${scope}`)}
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
                           {(['assignee', 'mode', 'trigger', 'creator'] as const).map((key) => (
                              <CommandItem
                                 key={key}
                                 onSelect={() => setPane(key)}
                                 className="justify-between"
                              >
                                 {t(`filters.${key}`)}
                                 <ChevronRight className="size-4" />
                              </CommandItem>
                           ))}
                        </CommandGroup>
                        {count > 0 ? (
                           <>
                              <CommandSeparator />
                              <CommandGroup>
                                 <CommandItem
                                    onSelect={() =>
                                       set({
                                          assigneeId: null,
                                          mode: 'all',
                                          trigger: 'all',
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
               ) : pane === 'assignee' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.assignee')}</span>
                     </div>
                     <CommandInput placeholder={t('filters.searchAssignees')} />
                     <CommandList>
                        <CommandGroup>
                           <CommandItem
                              onSelect={() => set({ assigneeId: null })}
                              className="justify-between"
                           >
                              {t('filters.anyAssignee')}
                              {criteria.assigneeId === null ? <Check className="size-4" /> : null}
                           </CommandItem>
                           {assignees.map((assignee) => (
                              <CommandItem
                                 key={assignee.id}
                                 value={assignee.name}
                                 onSelect={() => set({ assigneeId: assignee.id })}
                                 className="justify-between"
                              >
                                 {assignee.name}
                                 {criteria.assigneeId === assignee.id ? (
                                    <Check className="size-4" />
                                 ) : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               ) : pane === 'mode' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.mode')}</span>
                     </div>
                     <CommandList>
                        <CommandGroup>
                           {(['all', 'create_issue', 'fixed_issue'] as const).map((mode) => (
                              <CommandItem
                                 key={mode}
                                 onSelect={() => set({ mode })}
                                 className="justify-between"
                              >
                                 {mode === 'all' ? t('filters.any') : t(`mode.${mode}`)}
                                 {criteria.mode === mode ? <Check className="size-4" /> : null}
                              </CommandItem>
                           ))}
                        </CommandGroup>
                     </CommandList>
                  </Command>
               ) : pane === 'trigger' ? (
                  <Command>
                     <div className="flex items-center border-b p-2">
                        {back}
                        <span className="ml-2 font-medium">{t('filters.trigger')}</span>
                     </div>
                     <CommandList>
                        <CommandGroup>
                           {(['all', 'cron', 'webhook', 'none'] as const).map((trigger) => (
                              <CommandItem
                                 key={trigger}
                                 onSelect={() => set({ trigger })}
                                 className="justify-between"
                              >
                                 {trigger === 'all'
                                    ? t('filters.any')
                                    : t(`filters.trigger_${trigger}`)}
                                 {criteria.trigger === trigger ? (
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
                        {AUTOPILOT_SORTS.map((sort) => (
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
                        {AUTOPILOT_COLUMNS.map((column) => (
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
