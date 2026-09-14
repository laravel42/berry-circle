'use client';

import type { Issue } from '@/data/issues';
import type { Status } from '@/data/status';
import { cn } from '@/lib/utils';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { GripVertical } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { setIssueProject } from '@/lib/issues';
import { toast } from 'sonner';
import { useIssueGroups, usePropertyGrouping } from './issue-grouping';
import { IssueDragType } from './issue-grid';
import { sortIssues, useIssueListView } from './use-issue-list-view';

const LANE_ORDER_KEY = 'berry.swimlanes.order';

/** One card in a cell. Draggable so it can cross lanes and columns. */
function LaneCard({ issue }: { issue: Issue }) {
   const { orgId } = useParams<{ orgId: string }>();
   const ref = useRef<HTMLAnchorElement>(null);
   const [{ isDragging }, drag] = useDrag(
      () => ({
         type: IssueDragType,
         item: () => issue,
         collect: (m) => ({ isDragging: m.isDragging() }),
      }),
      [issue]
   );
   drag(ref);

   return (
      <Link
         ref={ref}
         href={`/${orgId}/issue/${issue.identifier}`}
         className={cn(
            'cursor-grab rounded border bg-background px-2 py-1 transition-opacity hover:bg-accent',
            isDragging && 'opacity-40'
         )}
      >
         <span className="text-muted-foreground">{issue.identifier}</span> {issue.title}
      </Link>
   );
}

/**
 * One lane/column cell. Dropping here says two things at once — the column's
 * status and the lane's value — so both are applied.
 */
function LaneCell({
   issues,
   status,
   onDrop,
}: {
   issues: Issue[];
   status: Status;
   onDrop: (issue: Issue, status: Status) => void;
}) {
   const ref = useRef<HTMLDivElement>(null);
   const [{ isOver }, drop] = useDrop(
      () => ({
         accept: IssueDragType,
         drop: (item: Issue) => onDrop(item, status),
         collect: (monitor) => ({ isOver: monitor.isOver() && monitor.canDrop() }),
      }),
      [status, onDrop]
   );
   drop(ref);

   return (
      <div
         ref={ref}
         className={cn(
            'flex flex-col gap-1 border-b border-l p-2 transition-colors',
            isOver && 'bg-accent/40'
         )}
      >
         {issues.map((issue) => (
            <LaneCard key={issue.id} issue={issue} />
         ))}
      </div>
   );
}

/**
 * Lanes across, statuses down.
 *
 * What a lane stands for follows the display grouping — assignee, parent,
 * project — so the same grid answers "who is on what" and "what belongs to
 * which piece of work" without a second layout. Lanes can be dragged into the
 * order a team actually reads them in, which is kept per browser.
 */
export function IssueSwimlanes({ issues, statuses }: { issues: Issue[]; statuses: Status[] }) {
   const view = useIssueListView();
   const property = usePropertyGrouping(view.grouping);
   const moveIssue = useIssuesStore((state) => state.moveIssue);
   const updateIssueAssignee = useIssuesStore((state) => state.updateIssueAssignee);
   const updateIssueProject = useIssuesStore((state) => state.updateIssueProject);
   const projects = useProjectsStore((state) => state.projects);
   const [laneOrder, setLaneOrder] = useState<string[]>([]);
   const [draggingLane, setDraggingLane] = useState<string | null>(null);

   useEffect(() => {
      try {
         const stored = window.localStorage.getItem(LANE_ORDER_KEY);
         if (stored) setLaneOrder(JSON.parse(stored) as string[]);
      } catch {
         // A corrupt preference just means the default order.
      }
   }, []);

   const grouping = view.grouping === 'status' ? 'assignee' : view.grouping;
   const groups = useIssueGroups({
      issues,
      totalIssues: issues,
      statuses,
      grouping,
      property,
   });

   const lanes = useMemo(() => {
      const ranked = [...groups].sort((a, b) => {
         const left = laneOrder.indexOf(a.group.id);
         const right = laneOrder.indexOf(b.group.id);
         if (left === -1 && right === -1) return 0;
         if (left === -1) return 1;
         if (right === -1) return -1;
         return left - right;
      });
      return ranked.map((entry) => ({
         ...entry,
         issues: sortIssues(entry.issues, view.ordering, view.direction),
      }));
   }, [groups, laneOrder, view.ordering, view.direction]);

   const persistOrder = (ids: string[]) => {
      setLaneOrder(ids);
      try {
         window.localStorage.setItem(LANE_ORDER_KEY, JSON.stringify(ids));
      } catch {
         // Not being able to remember the order is not a reason to refuse it.
      }
   };

   const dropInto = (laneId: string) => (issue: Issue, status: Status) => {
      if (issue.status.id !== status.id) {
         moveIssue(issue.id, { targetStatus: status, insertBeforeId: null });
      }
      if (grouping === 'assignee') {
         const lane = lanes.find((entry) => entry.group.id === laneId);
         const target = lane?.issues.find((entry) => entry.assignee)?.assignee ?? null;
         if (laneId === 'no-assignee') updateIssueAssignee(issue.id, null);
         else if (target && target.id !== issue.assignee?.id) updateIssueAssignee(issue.id, target);
      }
      if (grouping === 'project') {
         const next = laneId === 'no-project' ? undefined : projects.find((p) => p.id === laneId);
         if ((next?.id ?? null) !== (issue.project?.id ?? null)) {
            const previous = issue.project;
            updateIssueProject(issue.id, next);
            void setIssueProject(issue.identifier, next?.id ?? null).catch(() => {
               updateIssueProject(issue.id, previous);
               toast.error('That project could not be saved.');
            });
         }
      }
   };

   return (
      <DndProvider backend={HTML5Backend}>
         <div className="h-full overflow-auto">
            <div
               className="grid min-w-max"
               style={{ gridTemplateColumns: `200px repeat(${statuses.length}, 240px)` }}
            >
               <div className="sticky top-0 z-10 border-b bg-container px-3 py-2" />
               {statuses.map((status) => (
                  <div
                     key={status.id}
                     className="sticky top-0 z-10 border-b bg-container px-3 py-2 font-medium"
                  >
                     {status.name}
                  </div>
               ))}
               {lanes.map((lane) => (
                  <div key={lane.group.id} className="contents">
                     <div
                        draggable
                        onDragStart={() => setDraggingLane(lane.group.id)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                           if (!draggingLane || draggingLane === lane.group.id) return;
                           const ids = lanes.map((entry) => entry.group.id);
                           const next = ids.filter((id) => id !== draggingLane);
                           next.splice(next.indexOf(lane.group.id), 0, draggingLane);
                           persistOrder(next);
                           setDraggingLane(null);
                        }}
                        className={cn(
                           'flex cursor-grab items-center gap-1.5 border-b px-3 py-2 font-medium',
                           draggingLane === lane.group.id && 'opacity-50'
                        )}
                     >
                        <GripVertical className="size-3.5 text-muted-foreground" />
                        {lane.group.icon}
                        <span className="truncate">{lane.group.name}</span>
                        <span className="ml-auto text-muted-foreground">{lane.issues.length}</span>
                     </div>
                     {statuses.map((status) => (
                        <LaneCell
                           key={status.id}
                           status={status}
                           issues={lane.issues.filter((issue) => issue.status.id === status.id)}
                           onDrop={dropInto(lane.group.id)}
                        />
                     ))}
                  </div>
               ))}
            </div>
         </div>
      </DndProvider>
   );
}
