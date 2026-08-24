'use client';

import { Issue } from '@/data/issues';
import { Status } from '@/data/status';
import { useIssuesStore } from '@/store/issues-store';
import { useViewStore } from '@/store/view-store';
import { useCreateIssueStore } from '@/store/create-issue-store';
import { cn } from '@/lib/utils';
import { ChevronDown, Plus } from 'lucide-react';
import { FC, ReactNode, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { AnimatePresence, motion } from 'motion/react';
import { Button } from '../../ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { IssueDragType, IssueGrid } from './issue-grid';
import { IssueLine } from './issue-line';

/**
 * Generic descriptor of an issue group. Groups are usually statuses but the
 * "Display" settings also allow grouping by assignee / priority / project.
 */
export interface IssueGroupDescriptor {
   id: string;
   name: string;
   color: string;
   icon: ReactNode;
   /** Set when grouping by status: enables board drop + "+" default status. */
   status?: Status;
}

interface GroupIssuesProps {
   group: IssueGroupDescriptor;
   /** Issues of the group, already sorted upstream. */
   issues: Issue[];
   count: number;
}

/** Circle board/list header tint — ~6% alpha on board, ~3% on list. */
function statusHeaderTint(color: string, isViewTypeGrid: boolean): string {
   return `${color}${isViewTypeGrid ? '10' : '08'}`;
}

const BOARD_COLUMN_BODY_BG = 'var(--board-column-body)';

function GroupHeaderBar({
   group,
   count,
   isViewTypeGrid,
   showChevron,
   canCollapse,
}: {
   group: IssueGroupDescriptor;
   count: number;
   isViewTypeGrid: boolean;
   showChevron: boolean;
   canCollapse: boolean;
}) {
   const { openModal } = useCreateIssueStore();

   const label = (
      <>
         {showChevron ? (
            <ChevronDown
               aria-hidden
               className={cn(
                  'size-3.5 shrink-0 transition-transform duration-200 group-data-[state=closed]/issue-group:-rotate-90',
                  canCollapse ? 'text-muted-foreground' : 'text-muted-foreground/35'
               )}
            />
         ) : null}
         {group.icon}
         <span className="text-xs font-medium">{group.name}</span>
         <span className="text-xs text-muted-foreground">{count}</span>
      </>
   );

   const createButton = (
      <Button
         className={cn(isViewTypeGrid ? 'size-5' : 'size-6')}
         size="icon"
         variant="ghost"
         aria-label={`Create issue in ${group.name}`}
         onClick={(event) => {
            event.stopPropagation();
            openModal(group.status);
         }}
      >
         <Plus className={cn(isViewTypeGrid ? 'size-3.5' : 'size-4')} />
      </Button>
   );

   if (isViewTypeGrid) {
      return (
         <div
            className="flex h-full w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1"
            style={{ backgroundColor: statusHeaderTint(group.color, true) }}
         >
            <div className="flex min-w-0 items-center gap-2">{label}</div>
            {createButton}
         </div>
      );
   }

   return (
      <div className="sticky top-0 z-10 h-10 w-full bg-container">
         <div
            className="flex h-full w-full items-center justify-between px-6"
            style={{
               backgroundColor: statusHeaderTint(group.color, false),
            }}
         >
            {showChevron ? (
               <CollapsibleTrigger asChild>
                  <button
                     type="button"
                     disabled={!canCollapse}
                     className={cn(
                        'flex h-full min-w-0 flex-1 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        canCollapse ? 'cursor-pointer' : 'cursor-default'
                     )}
                  >
                     {label}
                  </button>
               </CollapsibleTrigger>
            ) : (
               <div className="flex items-center gap-2">{label}</div>
            )}
            {createButton}
         </div>
      </div>
   );
}

export function GroupIssues({ group, issues, count }: GroupIssuesProps) {
   const { viewType } = useViewStore();
   const isViewTypeGrid = viewType === 'grid';
   const showChevron = !isViewTypeGrid;
   const canCollapse = issues.length > 0;

   const header = (
      <GroupHeaderBar
         group={group}
         count={count}
         isViewTypeGrid={isViewTypeGrid}
         showChevron={showChevron}
         canCollapse={canCollapse}
      />
   );

   if (isViewTypeGrid) {
      return (
         <div className="bg-container flex h-full w-[278px] shrink-0 flex-col overflow-hidden rounded-lg">
            <div className="sticky top-0 z-10 h-9 w-full shrink-0 rounded-t-lg bg-container">
               {header}
            </div>
            <IssueGridList issues={issues} status={group.status} />
         </div>
      );
   }

   const rows = (
      <div className="space-y-0">
         {issues.map((issue) => (
            <IssueLine key={issue.id} issue={issue} layoutId={true} />
         ))}
      </div>
   );

   return (
      <Collapsible defaultOpen disabled={!canCollapse} className="group/issue-group bg-container">
         {header}
         <CollapsibleContent>{rows}</CollapsibleContent>
      </Collapsible>
   );
}

const IssueGridList: FC<{ issues: Issue[]; status?: Status }> = ({ issues, status }) => {
   const ref = useRef<HTMLDivElement>(null);
   const moveIssue = useIssuesStore((state) => state.moveIssue);
   const columnIssueIds = issues.map((issue) => issue.id);

   const [{ isOverColumn, isOverEmpty }, drop] = useDrop(
      () => ({
         accept: IssueDragType,
         canDrop: () => status !== undefined,
         drop(item: Issue, monitor) {
            if (monitor.didDrop()) return;
            if (!status) return;
            moveIssue(item.id, { targetStatus: status, insertBeforeId: null });
         },
         collect: (monitor) => ({
            isOverColumn: monitor.isOver() && monitor.canDrop(),
            isOverEmpty: monitor.isOver({ shallow: true }) && monitor.canDrop(),
         }),
      }),
      [status, moveIssue]
   );
   drop(ref);

   return (
      <div
         ref={ref}
         className={cn(
            'relative flex min-h-0 flex-1 flex-col space-y-1.5 overflow-y-auto rounded-b-lg p-1.5 transition-shadow',
            isOverColumn && issues.length > 0 && 'ring-2 ring-inset ring-primary/35'
         )}
         style={{ backgroundColor: BOARD_COLUMN_BODY_BG }}
      >
         <AnimatePresence>
            {isOverEmpty && issues.length === 0 && (
               <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.1 }}
                  className="pointer-events-none flex flex-1 items-center justify-center rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4"
               >
                  <p className="text-xs font-medium text-muted-foreground">Drop to move here</p>
               </motion.div>
            )}
         </AnimatePresence>
         {issues.map((issue, index) => (
            <IssueGrid
               key={issue.id}
               issue={issue}
               index={index}
               columnIssueIds={columnIssueIds}
               columnStatus={status}
            />
         ))}
      </div>
   );
};
