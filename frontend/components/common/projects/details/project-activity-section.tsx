'use client';

import { ContentBlocks } from '@/components/common/issues/details/content-blocks';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
   getProjectDetail,
   ProjectUpdate,
   ProjectUpdateHealth,
   projectUpdateHealthColor,
   projectUpdateHealthLabel,
} from '@/data/project-details';
import { useProject } from '@/hooks/use-project';
import { useProjectUpdatesStore } from '@/store/project-updates-store';
import { format, parseISO } from 'date-fns';
import { useMemo } from 'react';

function HealthDot({ health }: { health: ProjectUpdateHealth }) {
   return (
      <span
         className="size-2 shrink-0 rounded-full"
         style={{ backgroundColor: projectUpdateHealthColor[health] }}
         title={projectUpdateHealthLabel[health]}
      />
   );
}

function UpdateRow({ update }: { update: ProjectUpdate }) {
   return (
      <div className="rounded-sm border border-border/60 bg-container p-3.5">
         <div className="mb-1.5 flex items-center gap-2">
            <Avatar className="size-5">
               <AvatarImage src={update.author.avatarUrl} alt={update.author.name} />
               <AvatarFallback>{update.author.name[0]}</AvatarFallback>
            </Avatar>
            <span className="font-medium">{update.author.name}</span>
            <HealthDot health={update.health} />
            <span className="text-muted-foreground">{format(parseISO(update.date), 'MMM d')}</span>
         </div>
         <ContentBlocks blocks={update.blocks} />
      </div>
   );
}

/** Project activity list — matches issue ActivityFeedList layout. */
export function ProjectActivityFeedList({ projectId }: { projectId: string }) {
   const project = useProject(projectId);
   const detail = getProjectDetail(projectId);
   const { postedUpdates } = useProjectUpdatesStore();

   const updates = useMemo<ProjectUpdate[]>(
      () => (project ? [...(postedUpdates[project.id] ?? []), ...detail.updates] : []),
      [postedUpdates, project, detail.updates]
   );

   return (
      <div className="border-t border-border/60 pt-4">
         <div className="mb-1 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            activity
         </div>
         <div className="flex flex-col gap-1.5">
            {updates.length > 0 ? (
               updates.map((update) => <UpdateRow key={update.id} update={update} />)
            ) : (
               <p className="text-muted-foreground">No activity yet.</p>
            )}
         </div>
      </div>
   );
}
