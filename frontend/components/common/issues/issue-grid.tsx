'use client';

import { Issue } from '@/data/issues';
import { Status } from '@/data/status';
import { useDisplaySettingsStore } from '@/store/display-settings-store';
import { useIssuesStore } from '@/store/issues-store';
import { format } from 'date-fns';
import { GripVertical } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DragSourceMonitor, useDrag, useDragLayer, useDrop } from 'react-dnd';
import { getEmptyImage } from 'react-dnd-html5-backend';
import { AssigneeUser } from './assignee-user';
import { LabelBadge } from './label-badge';
import { ProjectBadge } from './project-badge';
import { SelectionCheckbox } from './selection-checkbox';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { IssueContextMenu } from './issue-context-menu';
import { WORKSPACE_SLUG } from '@/lib/config';
import { cn } from '@/lib/utils';

export const IssueDragType = 'ISSUE';

type IssueGridProps = {
   issue: Issue;
   index: number;
   columnIssueIds: string[];
   columnStatus?: Status;
   /** Applies the column's grouped value to a card dropped onto this one. */
   onDropIssue?: (issue: Issue) => void;
};

function IssueDragPreview({ issue }: { issue: Issue }) {
   return (
      <div className="w-full overflow-hidden rounded-lg border border-[var(--board-card-line)] bg-void p-2 text-chalk shadow-lg">
         <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-subtle-foreground">{issue.identifier}</span>
            <AssigneeUser user={issue.assignee} issueId={issue.id} placeholderForAgents />
         </div>
         {/* Plain text, not a heading: the ghost is a transient copy of the
             card that only exists mid-drag, so it has nothing to contribute to
             the document outline. */}
         <div className="mb-2 line-clamp-2 font-medium">{issue.title}</div>
         <div className="flex flex-wrap gap-1 mb-2 min-h-[1.25rem]">
            <LabelBadge label={issue.labels} />
            {issue.project && <ProjectBadge project={issue.project} />}
         </div>
         <div className="flex items-center mt-auto pt-1">
            <span className="text-muted-foreground">
               {format(new Date(issue.createdAt), 'MMM dd')}
            </span>
         </div>
      </div>
   );
}

export function CustomDragLayer() {
   const { itemType, isDragging, item, currentOffset } = useDragLayer((monitor) => ({
      item: monitor.getItem() as Issue,
      itemType: monitor.getItemType(),
      currentOffset: monitor.getSourceClientOffset(),
      isDragging: monitor.isDragging(),
   }));

   if (!isDragging || itemType !== IssueDragType || !currentOffset) {
      return null;
   }

   return (
      <div
         className="fixed pointer-events-none z-50 left-0 top-0"
         style={{
            transform: `translate(${currentOffset.x}px, ${currentOffset.y}px)`,
            width: '266px',
         }}
      >
         <IssueDragPreview issue={item} />
      </div>
   );
}

export function IssueGrid({
   issue,
   index,
   columnIssueIds,
   columnStatus,
   onDropIssue,
}: IssueGridProps) {
   const cardRef = useRef<HTMLDivElement>(null);
   const insertBeforeIdRef = useRef<string | null | undefined>(undefined);
   const { orgId } = useParams<{ orgId: string }>();
   const { displayProperties } = useDisplaySettingsStore();
   const moveIssue = useIssuesStore((state) => state.moveIssue);
   const [dropEdge, setDropEdge] = useState<'top' | 'bottom' | null>(null);

   const columnKey = columnIssueIds.join(',');

   const [{ isDragging }, drag, preview] = useDrag(
      () => ({
         type: IssueDragType,
         item: () => issue,
         collect: (monitor: DragSourceMonitor) => ({
            isDragging: monitor.isDragging(),
         }),
      }),
      [issue]
   );

   useEffect(() => {
      preview(getEmptyImage(), { captureDraggingState: true });
   }, [preview]);

   const [{ isOver }, drop] = useDrop(
      () => ({
         accept: IssueDragType,
         canDrop: (item: Issue) => item.id !== issue.id,
         hover(draggedItem: Issue, monitor) {
            if (!cardRef.current || draggedItem.id === issue.id) {
               return;
            }

            const rect = cardRef.current.getBoundingClientRect();
            const offset = monitor.getClientOffset();
            if (!offset) return;

            const middleY = (rect.bottom - rect.top) / 2;
            const clientY = offset.y - rect.top;
            const insertAfter = clientY > middleY;

            setDropEdge(insertAfter ? 'bottom' : 'top');
            insertBeforeIdRef.current = insertAfter
               ? index + 1 < columnIssueIds.length
                  ? columnIssueIds[index + 1]
                  : null
               : issue.id;
         },
         drop(draggedItem: Issue, monitor) {
            if (monitor.didDrop()) return;
            const insertBeforeId = insertBeforeIdRef.current;
            if (insertBeforeId === undefined) return;

            moveIssue(draggedItem.id, {
               targetStatus: columnStatus,
               insertBeforeId,
            });
            // A card dropped from another column lands in this one's group, so
            // whatever the board is grouped by takes this column's value.
            onDropIssue?.(draggedItem);
            insertBeforeIdRef.current = undefined;
            setDropEdge(null);
         },
         collect: (monitor) => ({
            isOver: monitor.isOver() && monitor.canDrop(),
         }),
      }),
      [issue.id, index, columnKey, columnStatus, moveIssue, onDropIssue]
   );

   drag(drop(cardRef));

   useEffect(() => {
      if (!isOver) {
         setDropEdge(null);
      }
   }, [isOver]);

   return (
      <div ref={cardRef} className="relative">
         {isOver && dropEdge === 'top' ? (
            <div className="pointer-events-none absolute inset-x-1 top-0 z-20 h-0.5 -translate-y-1/2 rounded-full bg-primary" />
         ) : null}
         {isOver && dropEdge === 'bottom' ? (
            <div className="pointer-events-none absolute inset-x-1 bottom-0 z-20 h-0.5 translate-y-1/2 rounded-full bg-primary" />
         ) : null}
         <ContextMenu>
            <ContextMenuTrigger asChild>
               <div
                  className={cn(
                     'group w-full cursor-grab rounded-lg bg-void p-2 pl-1.5 text-chalk transition-colors active:cursor-grabbing',
                     /* Not the themed `--border`, which would turn near-white on a
                        card that stays dark in both themes. `--board-card-line` is
                        the column behind it lifted a step, so the edge reads as a
                        seam. In dark the card and the column resolve to the same
                        colour, which leaves this border as the only thing marking
                        where one ends -- the shadow has nothing to fall against
                        and does its work in light mode. */
                     'border border-[var(--board-card-line)] shadow-sm',
                     'hover:bg-base',
                     isOver && 'ring-1 ring-primary/40',
                     isOver && dropEdge === 'top' && 'mt-1',
                     isOver && dropEdge === 'bottom' && 'mb-1'
                  )}
                  style={{ opacity: isDragging ? 0.45 : 1 }}
               >
                  <div className="flex gap-1.5">
                     <div
                        className="mt-0.5 flex h-5 w-3.5 shrink-0 items-start justify-center text-muted-foreground"
                        aria-hidden
                     >
                        <GripVertical className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                     </div>
                     <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                           <span className="flex min-w-0 items-center gap-1.5">
                              <SelectionCheckbox issueId={issue.id} order={columnIssueIds} />
                              {displayProperties.id ? (
                                 <span className="text-subtle-foreground">{issue.identifier}</span>
                              ) : null}
                           </span>
                           {displayProperties.assignee ? (
                              <AssigneeUser
                                 user={issue.assignee}
                                 issueId={issue.id}
                                 placeholderForAgents
                              />
                           ) : null}
                        </div>
                        <Link
                           href={`/${orgId ?? WORKSPACE_SLUG}/issue/${issue.identifier}`}
                           className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                           draggable={false}
                           onClick={(event) => {
                              if (isDragging) event.preventDefault();
                           }}
                        >
                           {/* Sized as body text, so under the type scale it
                               cannot be an h1-h4 -- those carry sizes. The
                               heading role keeps what the element was giving
                               back: a grid of cards is skimmed by its titles,
                               and dropping to a bare div would leave screen
                               readers tabbing every card to find one. */}
                           <div
                              className="mb-2 line-clamp-2 font-medium"
                              role="heading"
                              aria-level={4}
                           >
                              {issue.title}
                           </div>
                        </Link>
                        <div className="flex flex-wrap gap-1 mb-2 min-h-[1.25rem]">
                           {displayProperties.labels && <LabelBadge label={issue.labels} />}
                           {displayProperties.project && issue.project && (
                              <ProjectBadge project={issue.project} />
                           )}
                        </div>
                        {displayProperties.created ? (
                           <div className="mt-auto pt-1">
                              <span className="text-muted-foreground">
                                 {format(new Date(issue.createdAt), 'MMM dd')}
                              </span>
                           </div>
                        ) : null}
                     </div>
                  </div>
               </div>
            </ContextMenuTrigger>
            <IssueContextMenu issueId={issue.id} />
         </ContextMenu>
      </div>
   );
}
