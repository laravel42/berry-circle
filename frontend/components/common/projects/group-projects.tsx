'use client';

import { Button } from '@/components/ui/button';
import type { Project } from '@/data/projects';
import type { Status } from '@/data/status';
import { cn } from '@/lib/utils';
import { useCreateProjectStore } from '@/store/create-project-store';
import { useProjectsStore } from '@/store/projects-store';
import { Plus } from 'lucide-react';
import { FC, ReactNode, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { AnimatePresence, motion } from 'motion/react';
import { ProjectDragType, ProjectGrid } from './project-grid';

export interface ProjectGroupDescriptor {
   id: string;
   name: string;
   color: string;
   icon: ReactNode;
   /** Set when grouping by status — enables drag-drop and create-in-column. */
   status?: Status;
}

interface GroupProjectsProps {
   group: ProjectGroupDescriptor;
   projects: Project[];
   count: number;
}

const BOARD_COLUMN_BODY_BG = 'var(--board-column-body)';

function groupHeaderTint(color: string): string {
   return `${color}10`;
}

function GroupHeaderBar({ group, count }: { group: ProjectGroupDescriptor; count: number }) {
   const { openModal } = useCreateProjectStore();

   return (
      <div
         className="flex h-full w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1"
         style={{ backgroundColor: groupHeaderTint(group.color) }}
      >
         <div className="flex min-w-0 items-center gap-2">
            {group.icon}
            <span className="text-xs font-medium">{group.name}</span>
            <span className="text-xs text-muted-foreground">{count}</span>
         </div>
         <Button
            className="size-5"
            size="icon"
            variant="ghost"
            aria-label={`Create project in ${group.name}`}
            onClick={(event) => {
               event.stopPropagation();
               openModal(group.status);
            }}
         >
            <Plus className="size-3.5" />
         </Button>
      </div>
   );
}

export function GroupProjects({ group, projects, count }: GroupProjectsProps) {
   return (
      <div className="bg-container flex h-full w-[278px] shrink-0 flex-col overflow-hidden rounded-lg">
         <div className="sticky top-0 z-10 h-9 w-full shrink-0 rounded-t-lg bg-container">
            <GroupHeaderBar group={group} count={count} />
         </div>
         <ProjectGridList projects={projects} status={group.status} />
      </div>
   );
}

const ProjectGridList: FC<{ projects: Project[]; status?: Status }> = ({ projects, status }) => {
   const ref = useRef<HTMLDivElement>(null);
   const updateProjectStatus = useProjectsStore((state) => state.updateProjectStatus);

   const [{ isOverColumn, isOverEmpty }, drop] = useDrop(
      () => ({
         accept: ProjectDragType,
         canDrop: () => status !== undefined,
         drop(item: Project, monitor) {
            if (monitor.didDrop() || !status) return;
            if (item.status.id !== status.id) {
               updateProjectStatus(item.id, status);
            }
         },
         collect: (monitor) => ({
            isOverColumn: monitor.isOver() && monitor.canDrop(),
            isOverEmpty: monitor.isOver({ shallow: true }) && monitor.canDrop(),
         }),
      }),
      [status, updateProjectStatus]
   );
   drop(ref);

   return (
      <div
         ref={ref}
         className={cn(
            'relative flex min-h-0 flex-1 flex-col space-y-1.5 overflow-y-auto rounded-b-lg p-1.5 transition-shadow',
            isOverColumn && projects.length > 0 && 'ring-2 ring-inset ring-primary/35'
         )}
         style={{ backgroundColor: BOARD_COLUMN_BODY_BG }}
      >
         <AnimatePresence>
            {isOverEmpty && projects.length === 0 && (
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
         {projects.map((project) => (
            <ProjectGrid key={project.id} project={project} columnStatus={status} />
         ))}
      </div>
   );
};
