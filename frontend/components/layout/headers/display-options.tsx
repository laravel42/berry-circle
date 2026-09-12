'use client';

import { useState } from 'react';
import { SaveViewDialog } from '@/components/common/views/save-view-dialog';
import {
   groupingKeysForMode,
   modeTakesPropertyGrouping,
   ORDERING_KEYS,
   useIssueListView,
} from '@/components/common/issues/use-issue-list-view';
import { useWorkspaceProperties } from '@/components/common/issues/issue-grouping';
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
import type { ViewType } from '@/store/view-store';
import {
   ArrowDownWideNarrow,
   ArrowUpDown,
   ArrowUpNarrowWide,
   CalendarRange,
   LayoutGrid,
   LayoutList,
   Rows3,
   SlidersHorizontal,
   Table2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

const LAYOUTS: { value: ViewType; icon: React.ElementType }[] = [
   { value: 'list', icon: LayoutList },
   { value: 'grid', icon: LayoutGrid },
   { value: 'table', icon: Table2 },
   { value: 'swimlane', icon: Rows3 },
   { value: 'gantt', icon: CalendarRange },
];

/**
 * The Display popover of a task list: layout, grouping (per layout), ordering
 * and its direction, what counts as visible, and the per-row properties.
 */
export function DisplayOptions({ iconOnly = false }: { iconOnly?: boolean }) {
   const t = useTranslations('issueLists');
   const view = useIssueListView();
   const properties = useWorkspaceProperties();
   const [saveOpen, setSaveOpen] = useState(false);
   const {
      orderCompletedByRecency,
      completedIssues,
      showSubIssues,
      showEmptyGroups,
      displayProperties,
      setOrderCompletedByRecency,
      setCompletedIssues,
      setShowSubIssues,
      setShowEmptyGroups,
      toggleDisplayProperty,
      resetDisplaySettings,
   } = useDisplaySettingsStore();

   const isDefault =
      view.grouping === 'status' &&
      view.ordering === 'priority' &&
      view.direction === 'asc' &&
      completedIssues === 'all' &&
      !showEmptyGroups;

   const groupings = groupingKeysForMode(view.mode);
   const takesProperties = modeTakesPropertyGrouping(view.mode);

   // Spelled out rather than built from the key: `t()` is typed against the
   // English catalogue, and a template-literal key is not a key it can check.
   const layoutLabel: Record<ViewType, string> = {
      list: t('mode.list'),
      grid: t('mode.board'),
      table: t('mode.table'),
      swimlane: t('mode.swimlane'),
      gantt: t('mode.gantt'),
   };
   const groupingLabel: Record<string, string> = {
      status: t('display.status'),
      assignee: t('display.assignee'),
      priority: t('display.priority'),
      project: t('display.project'),
      parent: t('display.parent'),
      none: t('display.none'),
   };
   const orderingLabel: Record<OrderingKey, string> = {
      manual: t('display.manual'),
      status: t('display.status'),
      priority: t('display.priority'),
      dueDate: t('display.dueDate'),
      created: t('display.created'),
      updated: t('display.updated'),
      title: t('display.title'),
   };

   return (
      <>
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
                  {(!isDefault || view.mode !== 'list') && (
                     <span className="absolute right-0 top-0 w-2 h-2 bg-orange-500 rounded-full" />
                  )}
               </Button>
            </PopoverTrigger>
            <PopoverContent className="w-80 p-0" align="end">
               {/* Layout */}
               <div className="p-3">
                  <div className="grid grid-cols-5 gap-1 bg-accent/50 rounded-md p-1">
                     {LAYOUTS.map((layout) => (
                        <button
                           key={layout.value}
                           onClick={() => view.setMode(layout.value)}
                           className={cn(
                              'flex flex-col items-center justify-center gap-0.5 h-12 rounded font-medium transition-colors',
                              view.mode === layout.value
                                 ? 'bg-background shadow-sm'
                                 : 'text-muted-foreground'
                           )}
                        >
                           <layout.icon className="size-3.5" />
                           {layoutLabel[layout.value]}
                        </button>
                     ))}
                  </div>
               </div>

               {/* Grouping & ordering */}
               <div className="px-3 pb-3 flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                     <span className="flex items-center gap-1.5 text-muted-foreground">
                        <ArrowUpDown className="size-3.5" />
                        {t('display.grouping')}
                     </span>
                     <Select
                        value={view.grouping}
                        onValueChange={(value) => view.setGrouping(value as GroupingKey)}
                     >
                        <SelectTrigger className="h-7 w-36">
                           <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                           {groupings.map((key) => (
                              <SelectItem key={key} value={key}>
                                 {groupingLabel[key] ?? key}
                              </SelectItem>
                           ))}
                           {takesProperties &&
                              properties.map((definition) => (
                                 <SelectItem
                                    key={definition.id}
                                    value={`property:${definition.id}`}
                                 >
                                    {definition.name}
                                 </SelectItem>
                              ))}
                        </SelectContent>
                     </Select>
                  </div>

                  <div className="flex items-center justify-between gap-2">
                     <span className="flex items-center gap-1.5 text-muted-foreground">
                        <ArrowUpNarrowWide className="size-3.5" />
                        {t('display.ordering')}
                     </span>
                     <div className="flex items-center gap-1">
                        <Select
                           value={view.ordering}
                           onValueChange={(value) => view.setOrdering(value as OrderingKey)}
                        >
                           <SelectTrigger className="h-7 w-28">
                              <SelectValue />
                           </SelectTrigger>
                           <SelectContent>
                              {ORDERING_KEYS.map((key) => (
                                 <SelectItem key={key} value={key}>
                                    {orderingLabel[key]}
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                        <Button
                           size="icon"
                           variant="ghost"
                           className="size-7"
                           aria-label={
                              view.direction === 'asc'
                                 ? t('display.ascending')
                                 : t('display.descending')
                           }
                           title={
                              view.direction === 'asc'
                                 ? t('display.ascending')
                                 : t('display.descending')
                           }
                           onClick={() =>
                              view.setDirection(view.direction === 'asc' ? 'desc' : 'asc')
                           }
                        >
                           {view.direction === 'asc' ? (
                              <ArrowUpNarrowWide className="size-3.5" />
                           ) : (
                              <ArrowDownWideNarrow className="size-3.5" />
                           )}
                        </Button>
                     </div>
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
                        onValueChange={(value) =>
                           setCompletedIssues(value as CompletedIssuesFilter)
                        }
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
                        {t('display.subIssues')}
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
                     <Label
                        htmlFor="show-empty-groups"
                        className="text-muted-foreground font-normal"
                     >
                        Show empty groups
                     </Label>
                     <Switch
                        id="show-empty-groups"
                        checked={showEmptyGroups}
                        onCheckedChange={setShowEmptyGroups}
                     />
                  </div>

                  <span className="text-muted-foreground mt-1">{t('display.cardProperties')}</span>
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
                     {t('display.reset')}
                  </button>
                  <button className="text-indigo-500 dark:text-indigo-400 hover:underline">
                     Set default for everyone
                  </button>
               </div>
               <div className="border-t p-3">
                  <Button
                     size="sm"
                     variant="secondary"
                     className="w-full"
                     onClick={() => setSaveOpen(true)}
                  >
                     {t('filters.saveAsView')}
                  </Button>
               </div>
            </PopoverContent>
         </Popover>
         <SaveViewDialog open={saveOpen} onOpenChange={setSaveOpen} />
      </>
   );
}
