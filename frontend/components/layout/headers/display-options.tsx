'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
   CompletedIssuesFilter,
   DISPLAY_PROPERTIES,
   GroupingKey,
   OrderingKey,
   useDisplaySettingsStore,
} from '@/store/display-settings-store';
import { useViewStore } from '@/store/view-store';
import {
   ArrowUpNarrowWide,
   ArrowUpDown,
   CalendarRange,
   LayoutGrid,
   LayoutList,
   Rows3,
   SlidersHorizontal,
   Table2,
} from 'lucide-react';

const GROUPINGS: { value: GroupingKey; label: string }[] = [
   { value: 'status', label: 'Status' },
   { value: 'assignee', label: 'Assignee' },
   { value: 'priority', label: 'Priority' },
   { value: 'project', label: 'Project' },
   { value: 'none', label: 'No grouping' },
];

const ORDERINGS: { value: OrderingKey; label: string }[] = [
   { value: 'priority', label: 'Priority' },
   { value: 'created', label: 'Created' },
   { value: 'title', label: 'Title' },
];

/**
 * Linear-style "Display" popover: list/board switch, grouping, ordering,
 * completed-issue visibility, list options and display property chips.
 */
export function DisplayOptions({ iconOnly = false }: { iconOnly?: boolean }) {
   const { viewType, setViewType } = useViewStore();
   const {
      grouping,
      ordering,
      orderCompletedByRecency,
      completedIssues,
      showSubIssues,
      showEmptyGroups,
      displayProperties,
      setGrouping,
      setOrdering,
      setOrderCompletedByRecency,
      setCompletedIssues,
      setShowSubIssues,
      setShowEmptyGroups,
      toggleDisplayProperty,
      resetDisplaySettings,
   } = useDisplaySettingsStore();

   const isDefault =
      grouping === 'status' &&
      ordering === 'priority' &&
      completedIssues === 'all' &&
      !showEmptyGroups;

   return (
      <Popover>
         <PopoverTrigger asChild>
            <Button
               className="relative"
               size="xs"
               variant="secondary"
               aria-label={iconOnly ? 'Display' : undefined}
            >
               <SlidersHorizontal className={cn('size-4', !iconOnly && 'mr-1')} />
               {iconOnly ? null : 'Display'}
               {(!isDefault || viewType !== 'list') && (
                  <span className="absolute right-0 top-0 w-2 h-2 bg-orange-500 rounded-full" />
               )}
            </Button>
         </PopoverTrigger>
         <PopoverContent className="w-80 p-0" align="end">
            {/* List / Board switch */}
            <div className="p-3">
               <div className="grid grid-cols-5 gap-1 bg-accent/50 rounded-md p-1">
                  {(
                     [
                        ['list', 'List', LayoutList],
                        ['grid', 'Board', LayoutGrid],
                        ['table', 'Table', Table2],
                        ['swimlane', 'Lanes', Rows3],
                        ['gantt', 'Gantt', CalendarRange],
                     ] as const
                  ).map(([type, label, Icon]) => (
                     <button
                        key={type}
                        onClick={() => setViewType(type)}
                        className={cn(
                           'flex flex-col items-center justify-center gap-0.5 h-12 rounded font-medium transition-colors',
                           viewType === type ? 'bg-background shadow-sm' : 'text-muted-foreground'
                        )}
                     >
                        <Icon className="size-3.5" />
                        {label}
                     </button>
                  ))}
               </div>
            </div>

            {/* Grouping & ordering */}
            <div className="px-3 pb-3 flex flex-col gap-2.5">
               <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                     <ArrowUpDown className="size-3.5" />
                     Grouping
                  </span>
                  <Select value={grouping} onValueChange={(v) => setGrouping(v as GroupingKey)}>
                     <SelectTrigger className="h-7 w-36">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {GROUPINGS.map((option) => (
                           <SelectItem key={option.value} value={option.value}>
                              {option.label}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>

               <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground pl-5">Sub-grouping</span>
                  <Select value="none" disabled>
                     <SelectTrigger className="h-7 w-36">
                        <SelectValue placeholder="No grouping" />
                     </SelectTrigger>
                     <SelectContent>
                        <SelectItem value="none">No grouping</SelectItem>
                     </SelectContent>
                  </Select>
               </div>

               <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                     <ArrowUpNarrowWide className="size-3.5" />
                     Ordering
                  </span>
                  <Select value={ordering} onValueChange={(v) => setOrdering(v as OrderingKey)}>
                     <SelectTrigger className="h-7 w-36">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {ORDERINGS.map((option) => (
                           <SelectItem key={option.value} value={option.value}>
                              {option.label}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>

               <div className="flex items-center justify-between">
                  <Label
                     htmlFor="order-completed-recency"
                     className="text-muted-foreground font-normal"
                  >
                     Order completed by recency
                  </Label>
                  <Switch
                     id="order-completed-recency"
                     checked={orderCompletedByRecency}
                     onCheckedChange={setOrderCompletedByRecency}
                  />
               </div>
            </div>

            <div className="border-t px-3 py-3 flex flex-col gap-2.5">
               <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Completed tasks</span>
                  <Select
                     value={completedIssues}
                     onValueChange={(v) => setCompletedIssues(v as CompletedIssuesFilter)}
                  >
                     <SelectTrigger className="h-7 w-36">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="none">None</SelectItem>
                     </SelectContent>
                  </Select>
               </div>

               <div className="flex items-center justify-between">
                  <Label htmlFor="show-sub-issues" className="text-muted-foreground font-normal">
                     Show sub-tasks
                  </Label>
                  <Switch
                     id="show-sub-issues"
                     checked={showSubIssues}
                     onCheckedChange={setShowSubIssues}
                  />
               </div>
            </div>

            <div className="border-t px-3 py-3 flex flex-col gap-2.5">
               <span className="font-medium">List options</span>
               <div className="flex items-center justify-between">
                  <Label htmlFor="show-empty-groups" className="text-muted-foreground font-normal">
                     Show empty groups
                  </Label>
                  <Switch
                     id="show-empty-groups"
                     checked={showEmptyGroups}
                     onCheckedChange={setShowEmptyGroups}
                  />
               </div>

               <span className="text-muted-foreground mt-1">Display properties</span>
               <div className="flex flex-wrap gap-1.5">
                  {DISPLAY_PROPERTIES.map((property) => (
                     <button
                        key={property.key}
                        onClick={() => toggleDisplayProperty(property.key)}
                        className={cn(
                           'px-2 h-6 rounded-md border transition-colors',
                           displayProperties[property.key]
                              ? 'bg-accent border-border text-foreground'
                              : 'border-transparent bg-accent/40 text-muted-foreground hover:text-foreground'
                        )}
                     >
                        {property.label}
                     </button>
                  ))}
               </div>
            </div>

            <div className="border-t px-3 py-2.5 flex items-center justify-between">
               <button
                  onClick={resetDisplaySettings}
                  className="text-muted-foreground hover:text-foreground"
               >
                  Reset
               </button>
               <button className="text-indigo-500 dark:text-indigo-400 hover:underline">
                  Set default for everyone
               </button>
            </div>
         </PopoverContent>
      </Popover>
   );
}
