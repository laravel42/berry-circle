'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { CapacityRing } from '@/components/common/cycles/capacity-ring';
import type { Project } from '@/data/projects';
import { useProjectsDisplayStore } from '@/store/projects-display-store';
import { useProjectsStore } from '@/store/projects-store';
import type { Status } from '@/data/status';
import { cn } from '@/lib/utils';
import { format, parseISO } from 'date-fns';
import { GripVertical } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { DragSourceMonitor, useDrag, useDragLayer, useDrop } from 'react-dnd';
import { getEmptyImage } from 'react-dnd-html5-backend';

export const ProjectDragType = 'PROJECT';

type ProjectGridProps = {
   project: Project;
   columnStatus?: Status;
};

function ProjectDragPreview({ project }: { project: Project }) {
   return (
      <div className="w-full overflow-hidden rounded-lg bg-void p-2 text-chalk shadow-lg">
         <div className="mb-1.5 flex items-center justify-between gap-2">
            <project.icon className="size-3.5 text-subtle-foreground" />
            <Avatar className="size-4">
               <AvatarImage src={project.lead.avatarUrl} alt={project.lead.name} />
               <AvatarFallback>{project.lead.name[0]}</AvatarFallback>
            </Avatar>
         </div>
         <h3 className="mb-2 line-clamp-2">{project.name}</h3>
         <div className="flex items-center gap-2 text-muted-foreground">
            <CapacityRing value={project.percentComplete} color="#6771c5" />
            {project.percentComplete}%
         </div>
      </div>
   );
}

export function ProjectDragLayer() {
   const { itemType, isDragging, item, currentOffset } = useDragLayer((monitor) => ({
      item: monitor.getItem() as Project,
      itemType: monitor.getItemType(),
      currentOffset: monitor.getSourceClientOffset(),
      isDragging: monitor.isDragging(),
   }));

   if (!isDragging || itemType !== ProjectDragType || !currentOffset) {
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
         <ProjectDragPreview project={item} />
      </div>
   );
}

export function ProjectGrid({ project, columnStatus }: ProjectGridProps) {
   const cardRef = useRef<HTMLDivElement>(null);
   const { orgId } = useParams<{ orgId: string }>();
   const { displayProperties } = useProjectsDisplayStore();
   const updateProjectStatus = useProjectsStore((state) => state.updateProjectStatus);
   const [dropEdge, setDropEdge] = useState<'top' | 'bottom' | null>(null);

   const [{ isDragging }, drag, preview] = useDrag(
      () => ({
         type: ProjectDragType,
         item: () => project,
         canDrag: () => columnStatus !== undefined,
         collect: (monitor: DragSourceMonitor) => ({
            isDragging: monitor.isDragging(),
         }),
      }),
      [project, columnStatus]
   );

   useEffect(() => {
      preview(getEmptyImage(), { captureDraggingState: true });
   }, [preview]);

   const [{ isOver }, drop] = useDrop(
      () => ({
         accept: ProjectDragType,
         canDrop: (item: Project) => item.id !== project.id && columnStatus !== undefined,
         hover(_draggedItem: Project, monitor) {
            if (!cardRef.current) return;
            const rect = cardRef.current.getBoundingClientRect();
            const offset = monitor.getClientOffset();
            if (!offset) return;
            const middleY = (rect.bottom - rect.top) / 2;
            const clientY = offset.y - rect.top;
            setDropEdge(clientY > middleY ? 'bottom' : 'top');
         },
         drop(draggedItem: Project, monitor) {
            if (monitor.didDrop() || !columnStatus) return;
            if (draggedItem.status.id !== columnStatus.id) {
               updateProjectStatus(draggedItem.id, columnStatus);
            }
            setDropEdge(null);
         },
         collect: (monitor) => ({
            isOver: monitor.isOver() && monitor.canDrop(),
         }),
      }),
      [project.id, columnStatus, updateProjectStatus]
   );

   drag(drop(cardRef));

   useEffect(() => {
      if (!isOver) setDropEdge(null);
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
                     'hover:bg-base',
                     columnStatus === undefined && 'cursor-default',
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
                        {columnStatus ? (
                           <GripVertical className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                        ) : null}
                     </div>
                     <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                           <project.icon className="size-3.5 text-subtle-foreground shrink-0" />
                           {displayProperties.lead ? (
                              <Avatar className="size-4 shrink-0">
                                 <AvatarImage src={project.lead.avatarUrl} alt={project.lead.name} />
                                 <AvatarFallback>{project.lead.name[0]}</AvatarFallback>
                              </Avatar>
                           ) : null}
                        </div>
                        <Link
                           href={`/${orgId}/project/${project.id}/overview`}
                           className="rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                           draggable={false}
                           onClick={(event) => {
                              if (isDragging) event.preventDefault();
                           }}
                        >
                           <h3 className="mb-2 line-clamp-2">{project.name}</h3>
                        </Link>
                        <div className="flex flex-wrap items-center gap-2 mb-1 min-h-[1.25rem]">
                           {displayProperties.health && (
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                 <span
                                    className="size-1.5 rounded-full shrink-0"
                                    style={{ backgroundColor: project.health.color }}
                                 />
                                 {project.health.name}
                              </span>
                           )}
                           {displayProperties.priority && (
                              <project.priority.icon className="size-3.5 shrink-0 text-muted-foreground" />
                           )}
                           {displayProperties.status && (
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                 <CapacityRing value={project.percentComplete} color="#6771c5" />
                                 {project.percentComplete}%
                              </span>
                           )}
                           {displayProperties.targetDate && project.targetDate && (
                              <span className="text-muted-foreground">
                                 {format(parseISO(project.targetDate), 'MMM d')}
                              </span>
                           )}
                        </div>
                     </div>
                  </div>
               </div>
            </ContextMenuTrigger>
         </ContextMenu>
      </div>
   );
}
