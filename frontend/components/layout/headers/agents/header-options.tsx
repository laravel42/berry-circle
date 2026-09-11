'use client';

import { ArrowDown, ArrowUp, Check, Columns3, SlidersHorizontal } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { agentModelDisplay, modelPairKey } from '@/lib/agents';
import { cn } from '@/lib/utils';
import {
   AGENT_COLUMNS,
   hasActiveFilters,
   useAgentsListStore,
   type AgentColumn,
   type AgentFilters,
   type AgentsScope,
   type AgentsSortKey,
} from '@/store/agents-list-store';
import { useAgentsStore } from '@/store/agents-store';
import { useSessionStore } from '@/store/session-store';

/** One option in a filter menu: the value stored, and how it reads. */
interface Option {
   value: string;
   label: string;
}

const SCOPES: AgentsScope[] = ['mine', 'all', 'archived'];
const SORTS: AgentsSortKey[] = ['activity', 'name', 'runs', 'created'];

/**
 * The agents toolbar: which agents, narrowed how, in what order, showing what.
 *
 * Every control writes to the list store rather than to the table, because the
 * page mounts this as a header and the table as its body — they never share a
 * parent that could hold the state between them.
 */
export default function HeaderOptions() {
   const t = useTranslations('agentsChat.list');
   const sessionUserId = useSessionStore((state) => state.user?.id);
   const agents = useAgentsStore((state) => state.agents);
   const archived = useAgentsStore((state) => state.archived);
   const roster = useAgentsStore((state) => state.roster);
   const {
      scope,
      search,
      sortKey,
      sortDescending,
      filters,
      columns,
      setScope,
      setSearch,
      sortBy,
      setFilter,
      clearFilters,
      toggleColumn,
   } = useAgentsListStore();

   // An archive nobody has opened yet has no count rather than a count of
   // zero: the two mean different things and only one of them is known.
   const counts: Record<AgentsScope, number | null> = {
      mine: sessionUserId
         ? agents.filter((agent) => roster.get(agent.id)?.ownerId === sessionUserId).length
         : null,
      all: agents.length,
      archived: archived?.length ?? null,
   };

   const scopeLabel: Record<AgentsScope, string> = {
      mine: t('scopeMine'),
      all: t('scopeAll'),
      archived: t('scopeArchived'),
   };

   const columnLabel: Record<AgentColumn, string> = {
      presence: t('colPresence'),
      workload: t('colWorkload'),
      runtime: t('colRuntime'),
      activity: t('colActivity'),
      runs: t('colRuns'),
      lastActive: t('colLastActive'),
      model: t('colModel'),
      owner: t('colOwner'),
      access: t('colAccess'),
   };

   const sortLabel: Record<AgentsSortKey, string> = {
      activity: t('sortActivity'),
      name: t('sortName'),
      runs: t('sortRuns'),
      created: t('sortCreated'),
   };

   // Filter options come from what is actually on this workspace's roster, so
   // the menus never offer a runtime or an owner that would match no rows.
   const options = useMemo((): Record<keyof AgentFilters, Option[]> => {
      const runtimes = new Map<string, string>();
      const owners = new Map<string, string>();
      const models = new Map<string, string>();
      for (const agent of agents) {
         const entry = roster.get(agent.id);
         if (entry?.runtimeId) runtimes.set(entry.runtimeId, entry.runtimeName ?? entry.runtimeId);
         if (entry?.ownerId) owners.set(entry.ownerId, entry.ownerName ?? entry.ownerId);
         const key = modelPairKey(agent);
         if (key) models.set(key, agentModelDisplay(agent).label);
      }
      const named = (map: Map<string, string>): Option[] =>
         [...map.entries()]
            .map(([value, label]) => ({ value, label }))
            .sort((left, right) => left.label.localeCompare(right.label));
      return {
         availability: [
            { value: 'available', label: t('availabilityAvailable') },
            { value: 'busy', label: t('availabilityBusy') },
            { value: 'offline', label: t('availabilityOffline') },
            { value: 'unknown', label: t('availabilityUnknown') },
         ],
         access: [
            { value: 'everyone', label: t('accessEveryone') },
            { value: 'admins', label: t('accessAdmins') },
            { value: 'listed', label: t('accessListed') },
         ],
         runtime: [{ value: 'none', label: t('runtimeNone') }, ...named(runtimes)],
         owner: [{ value: 'workspace', label: t('ownerWorkspace') }, ...named(owners)],
         model: named(models),
      };
   }, [agents, roster, t]);

   const filterMenu = (key: keyof AgentFilters, label: string) => (
      <>
         <DropdownMenuLabel>{label}</DropdownMenuLabel>
         <DropdownMenuItem onSelect={() => setFilter(key, null)}>
            <Check className={cn('size-3.5', filters[key] === null ? 'opacity-100' : 'opacity-0')} />
            {t('filterAny')}
         </DropdownMenuItem>
         {options[key].map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => setFilter(key, option.value)}>
               <Check
                  className={cn(
                     'size-3.5',
                     filters[key] === option.value ? 'opacity-100' : 'opacity-0'
                  )}
               />
               <span className="truncate">{option.label}</span>
            </DropdownMenuItem>
         ))}
      </>
   );

   return (
      <div className="flex h-10 w-full items-center justify-between gap-3 border-b px-6 py-1.5">
         <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex shrink-0 items-center gap-1">
               {SCOPES.map((entry) => (
                  <button
                     key={entry}
                     type="button"
                     aria-pressed={scope === entry}
                     onClick={() => setScope(entry)}
                     className={cn(
                        'rounded-md px-2 py-1 transition-colors',
                        scope === entry
                           ? 'bg-muted text-foreground'
                           : 'text-muted-foreground hover:text-foreground'
                     )}
                  >
                     {scopeLabel[entry]}
                     {counts[entry] === null ? null : (
                        <span className="ml-1.5 tabular-nums text-muted-foreground">
                           {counts[entry]}
                        </span>
                     )}
                  </button>
               ))}
            </div>
            <Input
               value={search}
               onChange={(event) => setSearch(event.target.value)}
               placeholder={t('searchPlaceholder')}
               className="h-7 max-w-xs border-none bg-transparent px-0 text-foreground shadow-none placeholder:text-foreground/40"
               aria-label={t('searchLabel')}
            />
         </div>

         <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant={hasActiveFilters(filters) ? 'default' : 'secondary'}>
                     <SlidersHorizontal className="size-4" />
                     {t('filters')}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="max-h-96 w-60 overflow-y-auto">
                  {filterMenu('availability', t('filterAvailability'))}
                  <DropdownMenuSeparator />
                  {filterMenu('runtime', t('filterRuntime'))}
                  <DropdownMenuSeparator />
                  {filterMenu('access', t('filterAccess'))}
                  <DropdownMenuSeparator />
                  {filterMenu('owner', t('filterOwner'))}
                  <DropdownMenuSeparator />
                  {filterMenu('model', t('filterModel'))}
                  {hasActiveFilters(filters) ? (
                     <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => clearFilters()}>
                           {t('filtersClear')}
                        </DropdownMenuItem>
                     </>
                  ) : null}
               </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary">
                     <Columns3 className="size-4" />
                     {t('columns')}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="w-52">
                  {AGENT_COLUMNS.map((column) => (
                     <DropdownMenuItem
                        key={column}
                        // The menu stays open: choosing columns is a series of
                        // decisions, and reopening it after each one is a tax
                        // on the person who wants three of them.
                        onSelect={(event) => {
                           event.preventDefault();
                           toggleColumn(column);
                        }}
                     >
                        <Check
                           className={cn(
                              'size-3.5',
                              columns.includes(column) ? 'opacity-100' : 'opacity-0'
                           )}
                        />
                        {columnLabel[column]}
                     </DropdownMenuItem>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button size="xs" variant="secondary">
                     {sortLabel[sortKey]}
                     {sortDescending ? (
                        <ArrowDown className="size-4" />
                     ) : (
                        <ArrowUp className="size-4" />
                     )}
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuLabel>{t('sort')}</DropdownMenuLabel>
                  {SORTS.map((key) => (
                     <DropdownMenuItem key={key} onSelect={() => sortBy(key)}>
                        <Check
                           className={cn('size-3.5', sortKey === key ? 'opacity-100' : 'opacity-0')}
                        />
                        {sortLabel[key]}
                     </DropdownMenuItem>
                  ))}
               </DropdownMenuContent>
            </DropdownMenu>
         </div>
      </div>
   );
}
