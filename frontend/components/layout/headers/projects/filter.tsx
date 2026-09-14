'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   Command,
   CommandEmpty,
   CommandGroup,
   CommandInput,
   CommandItem,
   CommandList,
   CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { projectCreateStatusOptions } from '@/components/common/projects/create-project/project-status-options';
import { health as allHealth } from '@/data/projects';
import { priorities } from '@/data/priorities';
import { useMembersStore } from '@/store/members-store';
import { useProjectsFilterStore, type ProjectsFilterType } from '@/store/projects-filter-store';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
   ArrowUpDown,
   BarChart3,
   CheckIcon,
   ChevronRight,
   CircleDashed,
   HeartPulse,
   ListFilter,
   UserRound,
} from 'lucide-react';

type Section = ProjectsFilterType | 'sort';

/**
 * The project filter menu: health, priority, status and lead, each a
 * searchable list, plus the sort order and one way to clear everything.
 */
export function Filter() {
   const t = useTranslations('issueLists');
   const [open, setOpen] = useState(false);
   const [active, setActive] = useState<Section | null>(null);
   const members = useMembersStore((state) => state.members);

   const { filters, sort, toggleFilter, clearFilters, getActiveFiltersCount, setSort } =
      useProjectsFilterStore();

   const back = (title: string) => (
      <div className="flex items-center border-b p-2">
         <Button variant="ghost" size="icon" className="size-6" onClick={() => setActive(null)}>
            <ChevronRight className="size-4 rotate-180" />
         </Button>
         <span className="ml-2 font-medium">{title}</span>
      </div>
   );

   const entry = (section: Section, label: string, icon: React.ReactNode, count: number) => (
      <CommandItem
         onSelect={() => setActive(section)}
         className="flex items-center justify-between cursor-pointer"
      >
         <span className="flex items-center gap-2">
            {icon}
            {label}
         </span>
         <div className="flex items-center">
            {count > 0 && <span className="text-muted-foreground mr-1">{count}</span>}
            <ChevronRight className="size-4" />
         </div>
      </CommandItem>
   );

   return (
      <Popover open={open} onOpenChange={setOpen}>
         <PopoverTrigger asChild>
            <Button size="xs" variant="ghost" className="relative">
               <ListFilter className="size-4" />
               <span className="hidden sm:inline ml-1">Filter</span>
               {getActiveFiltersCount() > 0 && (
                  <span className="absolute -top-1 -right-1 bg-primary text-primary-foreground rounded-full size-4 flex items-center justify-center">
                     {getActiveFiltersCount()}
                  </span>
               )}
            </Button>
         </PopoverTrigger>
         <PopoverContent className="p-0 w-64" align="start">
            {active === null ? (
               <Command>
                  <CommandList>
                     <CommandGroup>
                        {entry(
                           'health',
                           'Health',
                           <HeartPulse className="size-4 text-muted-foreground" />,
                           filters.health.length
                        )}
                        {entry(
                           'status',
                           t('projects.status'),
                           <CircleDashed className="size-4 text-muted-foreground" />,
                           filters.status.length
                        )}
                        {entry(
                           'priority',
                           t('display.priority'),
                           <BarChart3 className="size-4 text-muted-foreground" />,
                           filters.priority.length
                        )}
                        {entry(
                           'lead',
                           t('projects.lead'),
                           <UserRound className="size-4 text-muted-foreground" />,
                           filters.lead.length
                        )}
                        {entry(
                           'sort',
                           'Sort by',
                           <ArrowUpDown className="size-4 text-muted-foreground" />,
                           0
                        )}
                     </CommandGroup>
                     {getActiveFiltersCount() > 0 && (
                        <>
                           <CommandSeparator />
                           <CommandGroup>
                              <CommandItem
                                 onSelect={() => clearFilters()}
                                 className="cursor-pointer"
                              >
                                 {t('states.clearFilters')}
                              </CommandItem>
                           </CommandGroup>
                        </>
                     )}
                  </CommandList>
               </Command>
            ) : active === 'health' ? (
               <Command>
                  {back('Health')}
                  <CommandInput placeholder="Search" />
                  <CommandList>
                     <CommandEmpty>No health found.</CommandEmpty>
                     <CommandGroup>
                        {allHealth.map((entryHealth) => (
                           <CommandItem
                              key={entryHealth.id}
                              value={`${entryHealth.id} ${entryHealth.name}`}
                              onSelect={() => toggleFilter('health', entryHealth.id)}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <span
                                    className="size-3 rounded-full"
                                    style={{ backgroundColor: entryHealth.color }}
                                 />
                                 {entryHealth.name}
                              </div>
                              {filters.health.includes(entryHealth.id) && <CheckIcon size={16} />}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            ) : active === 'status' ? (
               <Command>
                  {back(t('projects.status'))}
                  <CommandInput placeholder="Search" />
                  <CommandList>
                     <CommandEmpty>No status found.</CommandEmpty>
                     <CommandGroup>
                        {projectCreateStatusOptions.map((option) => (
                           <CommandItem
                              key={option.status.id}
                              value={option.label}
                              onSelect={() => toggleFilter('status', option.status.id)}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <option.status.icon />
                                 {option.label}
                              </div>
                              {filters.status.includes(option.status.id) && <CheckIcon size={16} />}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            ) : active === 'priority' ? (
               <Command>
                  {back(t('display.priority'))}
                  <CommandInput placeholder="Search" />
                  <CommandList>
                     <CommandEmpty>No priorities found.</CommandEmpty>
                     <CommandGroup>
                        {priorities.map((priority) => (
                           <CommandItem
                              key={priority.id}
                              value={`${priority.id} ${priority.name}`}
                              onSelect={() => toggleFilter('priority', priority.id)}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <priority.icon className="text-muted-foreground size-4" />
                                 {priority.name}
                              </div>
                              {filters.priority.includes(priority.id) && <CheckIcon size={16} />}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            ) : active === 'lead' ? (
               <Command>
                  {back(t('projects.lead'))}
                  <CommandInput placeholder="Search" />
                  <CommandList>
                     <CommandEmpty>No member found.</CommandEmpty>
                     <CommandGroup>
                        {members.map((member) => (
                           <CommandItem
                              key={member.id}
                              value={member.name}
                              onSelect={() => toggleFilter('lead', member.id)}
                              className="flex items-center justify-between"
                           >
                              <div className="flex items-center gap-2">
                                 <Avatar className="size-4">
                                    <AvatarImage src={member.avatarUrl} alt={member.name} />
                                    <AvatarFallback>{member.name[0]}</AvatarFallback>
                                 </Avatar>
                                 {member.name}
                              </div>
                              {filters.lead.includes(member.id) && <CheckIcon size={16} />}
                           </CommandItem>
                        ))}
                     </CommandGroup>
                  </CommandList>
               </Command>
            ) : (
               <Command>
                  {back('Sort by')}
                  <CommandList>
                     <CommandGroup heading="Title">
                        <CommandItem
                           onSelect={() => setSort('title-asc')}
                           className="flex items-center justify-between"
                        >
                           A → Z{sort === 'title-asc' && <CheckIcon size={16} />}
                        </CommandItem>
                        <CommandItem
                           onSelect={() => setSort('title-desc')}
                           className="flex items-center justify-between"
                        >
                           Z → A{sort === 'title-desc' && <CheckIcon size={16} />}
                        </CommandItem>
                     </CommandGroup>
                     <CommandSeparator />
                     <CommandGroup heading="Target date">
                        <CommandItem
                           onSelect={() => setSort('date-asc')}
                           className="flex items-center justify-between"
                        >
                           Oldest to newest
                           {sort === 'date-asc' && <CheckIcon size={16} />}
                        </CommandItem>
                        <CommandItem
                           onSelect={() => setSort('date-desc')}
                           className="flex items-center justify-between"
                        >
                           Newest to oldest
                           {sort === 'date-desc' && <CheckIcon size={16} />}
                        </CommandItem>
                     </CommandGroup>
                     <CommandSeparator />
                     <CommandGroup heading={t('projects.status')}>
                        <CommandItem
                           onSelect={() => setSort('status-asc')}
                           className="flex items-center justify-between"
                        >
                           Lowest to highest
                           {sort === 'status-asc' && <CheckIcon size={16} />}
                        </CommandItem>
                        <CommandItem
                           onSelect={() => setSort('status-desc')}
                           className="flex items-center justify-between"
                        >
                           Highest to lowest
                           {sort === 'status-desc' && <CheckIcon size={16} />}
                        </CommandItem>
                     </CommandGroup>
                  </CommandList>
               </Command>
            )}
         </PopoverContent>
      </Popover>
   );
}
