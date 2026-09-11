'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Issue } from '@/data/issues';
import { Status } from '@/data/status';
import { useDisplaySettingsStore } from '@/store/display-settings-store';
import { useFilterStore } from '@/store/filter-store';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { ChevronDown, RotateCcw, X } from 'lucide-react';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { GroupIssues } from './group-issues';
import { CustomDragLayer } from './issue-grid';
import { IssueGroupEntry, useIssueGroups, usePropertyGrouping } from './issue-grouping';
import { applySubIssueVisibility, sortIssues, useIssueListView } from './use-issue-list-view';

interface GroupedIssuesViewProps {
   /** Issues to display (after the filter bar has been applied). */
   issues: Issue[];
   /** Same scope of issues, before the filter bar — used for "hidden by filters" counts. */
   totalIssues: Issue[];
   /** Statuses to render when grouping by status (empty groups are skipped unless enabled). */
   statuses: Status[];
   isViewTypeGrid: boolean;
}

function EmptyQueue() {
   const { openModal } = useCreateIssueStore();

   return (
      <div className="flex min-h-64 w-full items-center justify-center px-6 py-12">
         <div className="flex max-w-sm flex-col items-center text-center">
            <BerryMark size="lg" tone="neutral" state="hollow" label="Empty task queue" />
            <h2 className="mt-5 font-display tracking-[-0.025em]">Nothing queued.</h2>
            <p className="mt-2 leading-relaxed text-muted-foreground">
               Create the first task, then assign the whole ticket when it is ready to move.
            </p>
            <Button className="mt-6 h-10 px-5" onClick={() => openModal()}>
               create task
            </Button>
         </div>
      </div>
   );
}

/** Shown when filters are on and nothing is left to show. */
function NoMatches() {
   const t = useTranslations('issueLists');
   const { clearFilters } = useFilterStore();

   return (
      <div className="flex min-h-64 w-full items-center justify-center px-6 py-12">
         <div className="flex max-w-sm flex-col items-center text-center">
            <BerryMark size="lg" tone="neutral" state="hollow" label="No matches" />
            <p className="mt-5 leading-relaxed text-muted-foreground">{t('states.noMatches')}</p>
            <Button variant="secondary" className="mt-5" onClick={clearFilters}>
               {t('states.clearFilters')}
            </Button>
         </div>
      </div>
   );
}

/** Footer shown when active filters hide issues — "n issues hidden by filters". */
function HiddenByFiltersFooter({ hiddenCount }: { hiddenCount: number }) {
   const t = useTranslations('issueLists');
   const { clearFilters } = useFilterStore();

   return (
      <div className="flex items-center justify-center gap-3 py-4 text-muted-foreground">
         <span>
            <span className="font-medium text-foreground">
               {hiddenCount} {hiddenCount === 1 ? 'issue' : 'issues'}
            </span>{' '}
            hidden by filters
         </span>
         <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
         >
            {t('states.clearFilters')}
            <X className="size-3" />
         </button>
      </div>
   );
}

/**
 * Board-only strip of columns that are not on the board: the ones a person hid
 * by hand (each with a way back) and the ones the active filters emptied.
 */
function HiddenColumns({
   manual,
   emptied,
   onRestore,
   onRestoreAll,
}: {
   manual: IssueGroupEntry[];
   emptied: IssueGroupEntry[];
   onRestore: (groupId: string) => void;
   onRestoreAll: () => void;
}) {
   const t = useTranslations('issueLists');
   const [open, setOpen] = useState(true);

   return (
      <div className="w-[256px] shrink-0 pt-1">
         <div className="flex items-center justify-between gap-1">
            <button
               type="button"
               onClick={() => setOpen((value) => !value)}
               className="flex items-center gap-1.5 px-2 py-1.5 font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
               <ChevronDown
                  className={cn('size-3.5 transition-transform', !open && '-rotate-90')}
               />
               {t('board.hiddenColumns')}
            </button>
            {manual.length > 0 ? (
               <Button size="xs" variant="ghost" onClick={onRestoreAll}>
                  {t('board.restoreAll')}
               </Button>
            ) : null}
         </div>
         {open && (
            <div className="flex flex-col gap-1.5 mt-1">
               {[...manual, ...emptied].map((entry) => {
                  const isManual = manual.includes(entry);
                  return (
                     <div
                        key={entry.group.id}
                        className="flex items-center justify-between gap-2 rounded-lg border bg-container px-3 h-9"
                     >
                        <div className="flex items-center gap-2 min-w-0">
                           {entry.group.icon}
                           <span className="truncate">{entry.group.name}</span>
                        </div>
                        {isManual ? (
                           <Button
                              size="icon"
                              variant="ghost"
                              className="size-6 shrink-0"
                              aria-label={t('board.restore')}
                              title={t('board.restore')}
                              onClick={() => onRestore(entry.group.id)}
                           >
                              <RotateCcw className="size-3.5" />
                           </Button>
                        ) : (
                           <span className="text-muted-foreground whitespace-nowrap">
                              {entry.total > 0 ? `0 / ${entry.total}` : '0'}
                           </span>
                        )}
                     </div>
                  );
               })}
            </div>
         )}
      </div>
   );
}

/**
 * Issues grouped according to the Display settings — list rows or board
 * columns. Grouping, ordering and its direction, completed-task visibility and
 * sub-task visibility all come from `useIssueListView`, so a link reproduces
 * the list it was copied from.
 */
export const GroupedIssuesView: FC<GroupedIssuesViewProps> = ({
   issues,
   totalIssues,
   statuses,
   isViewTypeGrid,
}) => {
   const t = useTranslations('issueLists');
   const view = useIssueListView();
   const {
      hiddenBoardColumns,
      hideBoardColumn,
      restoreBoardColumn,
      restoreAllBoardColumns,
      showSubIssues,
      completedIssues,
      showEmptyGroups,
   } = useDisplaySettingsStore();
   const { filters } = useFilterStore();
   const hasActiveFilters = filters.length > 0;
   const property = usePropertyGrouping(view.grouping);
   const warned = useRef(false);

   // A field that was deleted while a list was grouped by it leaves every task
   // in one nameless bucket. Say so once, and put the grouping back.
   useEffect(() => {
      if (!property?.missing || warned.current) return;
      warned.current = true;
      toast.info(t('states.groupRemoved', { name: view.grouping.slice('property:'.length) }));
      view.setGrouping('status');
   }, [property?.missing, t, view]);

   const scoped = useMemo(() => {
      const hideDone = (list: Issue[]) =>
         completedIssues === 'none'
            ? list.filter(
                 (issue) =>
                    issue.status.category !== 'completed' && issue.status.category !== 'canceled'
              )
            : list;
      return {
         visible: applySubIssueVisibility(hideDone(issues), showSubIssues),
         total: applySubIssueVisibility(hideDone(totalIssues), showSubIssues),
      };
   }, [issues, totalIssues, completedIssues, showSubIssues]);

   const rawGroups = useIssueGroups({
      issues: scoped.visible,
      totalIssues: scoped.total,
      statuses,
      grouping: view.grouping,
      property,
   });

   const groups = useMemo(
      () =>
         rawGroups.map((entry) => ({
            ...entry,
            issues: sortIssues(entry.issues, view.ordering, view.direction),
         })),
      [rawGroups, view.ordering, view.direction]
   );

   const hiddenCount = Math.max(0, scoped.total.length - scoped.visible.length);
   const showFooter = hasActiveFilters && hiddenCount > 0;
   const nothingLeft = scoped.visible.length === 0;

   /* ------------------------------- Board ------------------------------- */
   if (isViewTypeGrid) {
      const manuallyHidden = groups.filter((entry) => hiddenBoardColumns.includes(entry.group.id));
      const onBoard = groups.filter(
         (entry) =>
            !hiddenBoardColumns.includes(entry.group.id) &&
            (hasActiveFilters
               ? entry.issues.length > 0
               : showEmptyGroups || entry.issues.length > 0)
      );
      const emptied = hasActiveFilters
         ? groups.filter(
              (entry) => !hiddenBoardColumns.includes(entry.group.id) && entry.issues.length === 0
           )
         : [];

      return (
         <DndProvider backend={HTML5Backend}>
            <CustomDragLayer />
            <div className="h-full flex flex-col">
               <div className="flex-1 min-h-0 overflow-x-auto">
                  <div className="flex h-full min-w-max gap-3 px-4 py-3">
                     {onBoard.map((entry) => (
                        <GroupIssues
                           key={entry.group.id}
                           group={entry.group}
                           issues={entry.issues}
                           count={entry.issues.length}
                           onHide={() => hideBoardColumn(entry.group.id)}
                        />
                     ))}
                     {manuallyHidden.length + emptied.length > 0 && (
                        <HiddenColumns
                           manual={manuallyHidden}
                           emptied={emptied}
                           onRestore={restoreBoardColumn}
                           onRestoreAll={restoreAllBoardColumns}
                        />
                     )}
                     {onBoard.length === 0 &&
                        manuallyHidden.length + emptied.length === 0 &&
                        (hasActiveFilters ? <NoMatches /> : <EmptyQueue />)}
                  </div>
               </div>
               {showFooter && (
                  <div className="shrink-0 border-t bg-container">
                     <HiddenByFiltersFooter hiddenCount={hiddenCount} />
                  </div>
               )}
            </div>
         </DndProvider>
      );
   }

   /* -------------------------------- List ------------------------------- */
   const listGroups = groups.filter((entry) => showEmptyGroups || entry.issues.length > 0);

   return (
      <DndProvider backend={HTML5Backend}>
         <CustomDragLayer />
         <div className="h-full overflow-y-auto divide-y-[3px] divide-background">
            {nothingLeft && (hasActiveFilters ? <NoMatches /> : <EmptyQueue />)}
            {!nothingLeft &&
               listGroups.map((entry) => (
                  <GroupIssues
                     key={entry.group.id}
                     group={entry.group}
                     issues={entry.issues}
                     count={entry.issues.length}
                  />
               ))}
            {showFooter && !nothingLeft && <HiddenByFiltersFooter hiddenCount={hiddenCount} />}
         </div>
      </DndProvider>
   );
};
