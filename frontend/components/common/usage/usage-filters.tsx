'use client';

import { Check, Globe, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
   Command,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { listBoards, type BoardSummary } from '@/lib/boards';
import { knownTimezones, localTimezone } from '@/lib/cron-schedule';
import { USAGE_DAY_OPTIONS, type UsageQuery } from '@/lib/usage';

interface Props {
   query: UsageQuery;
   onChange: (query: UsageQuery) => void;
   lastUpdated: Date | null;
   loading: boolean;
   onRefresh: () => void;
}

/**
 * What every usage read is asking: how far back, on which project, and in
 * whose days — plus when the answer on screen arrived, and a way to ask again.
 */
export default function UsageFilters({ query, onChange, lastUpdated, loading, onRefresh }: Props) {
   const t = useTranslations('areas.usage.filters');
   const [boards, setBoards] = useState<BoardSummary[]>([]);
   const zones = useMemo(knownTimezones, []);

   useEffect(() => {
      let cancelled = false;
      void listBoards().then(
         (found) => {
            if (!cancelled) setBoards(found);
         },
         () => undefined
      );
      return () => {
         cancelled = true;
      };
   }, []);

   const project = boards.find((board) => board.id === query.boardId);

   return (
      <div className="flex flex-wrap items-center gap-2">
         <div className="flex items-center gap-1 rounded-md border p-0.5">
            {USAGE_DAY_OPTIONS.map((days) => (
               <Button
                  key={days}
                  size="xxs"
                  variant={query.days === days ? 'secondary' : 'ghost'}
                  onClick={() => onChange({ ...query, days })}
               >
                  {t('days', { count: days })}
               </Button>
            ))}
         </div>

         <Popover>
            <PopoverTrigger asChild>
               <Button size="xs" variant="ghost">
                  {project ? project.name : t('allProjects')}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="start">
               <Command>
                  <CommandInput placeholder={t('searchProjects')} />
                  <CommandList>
                     <CommandGroup>
                        <CommandItem
                           onSelect={() => onChange({ ...query, boardId: null })}
                           className="justify-between"
                        >
                           {t('allProjects')}
                           {!query.boardId ? <Check className="size-4" /> : null}
                        </CommandItem>
                        {boards.map((board) => (
                           <CommandItem
                              key={board.id}
                              value={board.name}
                              onSelect={() => onChange({ ...query, boardId: board.id })}
                              className="justify-between"
                           >
                              {board.name}
                              {query.boardId === board.id ? <Check className="size-4" /> : null}
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
                  <Globe className="mr-1 size-4" />
                  {query.timezone ?? 'UTC'}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start">
               <Command>
                  <CommandInput placeholder={t('searchZones')} />
                  <CommandList>
                     <CommandGroup>
                        {['UTC', localTimezone(), ...zones].map((zone, index) => (
                           <CommandItem
                              key={`${zone}-${index}`}
                              value={zone}
                              onSelect={() => onChange({ ...query, timezone: zone })}
                              className="justify-between"
                           >
                              {zone}
                              {(query.timezone ?? 'UTC') === zone ? (
                                 <Check className="size-4" />
                              ) : null}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            </PopoverContent>
         </Popover>

         <span className="ml-auto flex items-center gap-2 text-muted-foreground">
            {lastUpdated ? t('updated', { when: lastUpdated.toLocaleTimeString() }) : t('never')}
            <Button
               size="icon"
               variant="ghost"
               className="size-7"
               aria-label={t('refresh')}
               disabled={loading}
               onClick={onRefresh}
            >
               <RefreshCw className="size-4" />
            </Button>
         </span>
      </div>
   );
}
