'use client';

import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuCheckboxItem,
   DropdownMenuContent,
   DropdownMenuLabel,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { InboxItem } from '@/data/inbox';
import { priorities } from '@/data/priorities';
import { status as statusCatalog } from '@/data/status';
import { cn } from '@/lib/utils';
import { ChevronDown, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import {
   activeFilterCount,
   countFacet,
   SENDER_AGENT,
   SENDER_SYSTEM,
   type FacetResolver,
   type InboxFilters,
} from './use-inbox';

interface InboxFilterBarProps {
   /** The list before filtering, so counts describe what is available. */
   items: InboxItem[];
   facetsOf: FacetResolver;
   filters: InboxFilters;
   onChange: (next: InboxFilters) => void;
   /** A sender key rendered as a name. */
   senderName: (key: string) => string;
}

function toggle(values: string[], value: string): string[] {
   return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

/**
 * Status, priority, sender and unread, over the list.
 *
 * Counts sit beside every value because the useful question is not "does this
 * status exist" but "is there anything here in it" — a filter that empties the
 * list is a dead end a reader should be able to see coming.
 */
export function InboxFilterBar({
   items,
   facetsOf,
   filters,
   onChange,
   senderName,
}: InboxFilterBarProps) {
   const t = useTranslations('inbox');

   const statusCounts = useMemo(
      () => countFacet(items, facetsOf, (facets) => facets.status),
      [items, facetsOf]
   );
   const priorityCounts = useMemo(
      () => countFacet(items, facetsOf, (facets) => facets.priority),
      [items, facetsOf]
   );
   const senderCounts = useMemo(
      () => countFacet(items, facetsOf, (facets) => facets.sender),
      [items, facetsOf]
   );

   const senderKeys = useMemo(() => {
      const keys = Object.keys(senderCounts);
      // People first, then the two buckets that are not people.
      const special = keys.filter((key) => key === SENDER_AGENT || key === SENDER_SYSTEM);
      const people = keys.filter((key) => key !== SENDER_AGENT && key !== SENDER_SYSTEM);
      people.sort((left, right) => senderName(left).localeCompare(senderName(right)));
      return [...people, ...special];
   }, [senderCounts, senderName]);

   const active = activeFilterCount(filters);

   return (
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
         <FilterMenu
            label={t('filters.status')}
            selected={filters.statuses}
            options={statusCatalog.map((entry) => ({
               value: entry.id,
               label: entry.name,
               count: statusCounts[entry.id] ?? 0,
            }))}
            onToggle={(value) =>
               onChange({ ...filters, statuses: toggle(filters.statuses, value) })
            }
         />
         <FilterMenu
            label={t('filters.priority')}
            selected={filters.priorities}
            options={priorities.map((entry) => ({
               value: entry.id,
               label: entry.name,
               count: priorityCounts[entry.id] ?? 0,
            }))}
            onToggle={(value) =>
               onChange({ ...filters, priorities: toggle(filters.priorities, value) })
            }
         />
         <FilterMenu
            label={t('filters.sender')}
            selected={filters.senders}
            emptyLabel={t('filters.anySender')}
            options={senderKeys.map((key) => ({
               value: key,
               label: senderName(key),
               count: senderCounts[key] ?? 0,
            }))}
            onToggle={(value) => onChange({ ...filters, senders: toggle(filters.senders, value) })}
         />
         <Button
            size="xs"
            variant={filters.unreadOnly ? 'secondary' : 'ghost'}
            aria-pressed={filters.unreadOnly}
            onClick={() => onChange({ ...filters, unreadOnly: !filters.unreadOnly })}
         >
            {t('filters.unreadOnly')}
         </Button>
         {active > 0 ? (
            <Button
               size="xs"
               variant="ghost"
               className="ml-auto text-muted-foreground"
               onClick={() =>
                  onChange({ statuses: [], priorities: [], senders: [], unreadOnly: false })
               }
            >
               <X className="size-3.5" />
               {t('filters.clear')}
            </Button>
         ) : null}
      </div>
   );
}

interface FilterMenuProps {
   label: string;
   selected: string[];
   options: { value: string; label: string; count: number }[];
   onToggle: (value: string) => void;
   emptyLabel?: string;
}

function FilterMenu({ label, selected, options, onToggle, emptyLabel }: FilterMenuProps) {
   return (
      <DropdownMenu>
         <DropdownMenuTrigger asChild>
            <Button size="xs" variant={selected.length > 0 ? 'secondary' : 'ghost'}>
               {label}
               {selected.length > 0 ? (
                  <span className="text-muted-foreground">{selected.length}</span>
               ) : null}
               <ChevronDown className="size-3.5" />
            </Button>
         </DropdownMenuTrigger>
         <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {options.length === 0 ? (
               <div className="px-2 py-1.5 text-muted-foreground">{emptyLabel ?? '—'}</div>
            ) : (
               options.map((option) => (
                  <DropdownMenuCheckboxItem
                     key={option.value}
                     checked={selected.includes(option.value)}
                     onCheckedChange={() => onToggle(option.value)}
                  >
                     <span className="flex-1 truncate">{option.label}</span>
                     <span
                        className={cn(
                           'ml-2 shrink-0 tabular-nums text-muted-foreground',
                           option.count === 0 && 'opacity-50'
                        )}
                     >
                        {option.count}
                     </span>
                  </DropdownMenuCheckboxItem>
               ))
            )}
         </DropdownMenuContent>
      </DropdownMenu>
   );
}
