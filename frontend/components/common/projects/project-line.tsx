'use client';

import { PinToggle } from '@/components/common/issues/details/issue-pin-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Issue } from '@/data/issues';
import { priorities } from '@/data/priorities';
import { Project } from '@/data/projects';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsDisplayStore } from '@/store/projects-display-store';
import { useProjectsStore } from '@/store/projects-store';
import { useMembersStore } from '@/store/members-store';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { format } from 'date-fns';
import { DeleteProjectDialog, useProjectDeletion } from './delete-project';
import { projectCreateStatusOptions } from './create-project/project-status-options';
import { HealthPopover } from './health-popover';
import { PrioritySelector } from './priority-selector';
import { LeadSelector } from './lead-selector';
import { StatusWithPercent } from './status-with-percent';
import { DatePicker } from './date-picker';
import { cn } from '@/lib/utils';

interface ProjectLineProps {
   project: Project;
   /** Set when the list offers selection; undefined leaves the row without a box. */
   selected?: boolean;
   onToggleSelected?: () => void;
}

const countIssues = (issues: Issue[], projectId: string) =>
   issues.filter((issue) => issue.project?.id === projectId).length;

export default function ProjectLine({ project, selected, onToggleSelected }: ProjectLineProps) {
   const t = useTranslations('issueLists');
   const { orgId } = useParams<{ orgId: string }>();
   const { issues } = useIssuesStore();
   const members = useMembersStore((state) => state.members);
   const {
      updateProjectStatus,
      updateProjectPriority,
      updateProjectTargetDate,
      updateProjectLead,
   } = useProjectsStore();
   const { displayProperties } = useProjectsDisplayStore();
   const deletion = useProjectDeletion();
   const issueCount = useMemo(() => countIssues(issues, project.id), [issues, project.id]);

   return (
      <div
         className={cn(
            'group relative flex w-full items-center border-b border-border/45 px-6 py-3 transition-colors',
            'hover:bg-accent/45 focus-within:bg-accent/45'
         )}
      >
         <Link
            href={`/${orgId}/project/${project.id}/overview`}
            className="absolute inset-0 z-0 cursor-pointer"
            aria-label={project.name}
         />

         {onToggleSelected ? (
            <span
               className="relative z-10 mr-2 flex shrink-0 items-center"
               onClick={(event) => event.stopPropagation()}
               role="presentation"
            >
               <Checkbox
                  checked={selected}
                  onCheckedChange={onToggleSelected}
                  aria-label={`Select ${project.name}`}
               />
            </span>
         ) : null}

         <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 pointer-events-none">
            <div className="relative">
               <div className="inline-flex size-6 shrink-0 items-center justify-center rounded bg-muted/50">
                  <project.icon className="size-4" />
               </div>
            </div>
            <div className="flex flex-col items-start overflow-hidden">
               <span className="w-full truncate font-medium transition-colors group-hover:text-foreground">
                  {project.name}
               </span>
            </div>
            {displayProperties.labels &&
               project.labels.map((label) => (
                  <span
                     key={label.id}
                     className="hidden shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-muted-foreground lg:inline-flex"
                  >
                     <span
                        className="size-1.5 rounded-full"
                        style={{ backgroundColor: label.color }}
                     />
                     {label.name}
                  </span>
               ))}
         </div>

         {displayProperties.health && (
            <div className="relative z-10 hidden w-[120px] shrink-0 pointer-events-auto sm:block">
               <HealthPopover project={project} />
            </div>
         )}
         {displayProperties.priority && (
            <div className="relative z-10 hidden w-[70px] shrink-0 pointer-events-auto md:block">
               <PrioritySelector
                  priority={project.priority}
                  onPriorityChange={(priorityId) => {
                     const match = priorities.find((entry) => entry.id === priorityId);
                     if (match) updateProjectPriority(project.id, match);
                  }}
               />
            </div>
         )}
         {displayProperties.lead && (
            <div className="relative z-10 hidden w-[130px] shrink-0 pointer-events-auto xl:block">
               <LeadSelector
                  lead={project.lead}
                  members={members}
                  onLeadChange={(userId) => {
                     const member = members.find((entry) => entry.id === userId);
                     if (member) updateProjectLead(project.id, member);
                  }}
               />
            </div>
         )}
         {displayProperties.targetDate && (
            <div className="relative z-10 hidden w-[110px] shrink-0 pointer-events-auto xl:block">
               <DatePicker
                  date={project.targetDate ? new Date(project.targetDate) : undefined}
                  onDateChange={(date) => {
                     updateProjectTargetDate(
                        project.id,
                        date ? format(date, 'yyyy-MM-dd') : undefined
                     );
                  }}
               />
            </div>
         )}
         {displayProperties.issues && (
            <div className="relative z-10 hidden w-[60px] shrink-0 pl-2.5 text-muted-foreground pointer-events-none xl:block">
               {issueCount}
            </div>
         )}
         {displayProperties.status && (
            <div className="relative z-10 w-[90px] shrink-0 pointer-events-auto">
               <StatusWithPercent
                  status={project.status}
                  percentComplete={project.percentComplete}
                  onStatusChange={(statusId) => {
                     const match = projectCreateStatusOptions.find(
                        (option) => option.status.id === statusId
                     );
                     if (match) updateProjectStatus(project.id, match.status);
                  }}
               />
            </div>
         )}

         {/* The row's own actions. Pinning is one click because it is the one
             people do from a list; anything destructive stays behind a menu
             and a confirmation. */}
         <div className="relative z-10 ml-1 flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <PinToggle targetType="project" targetId={project.id} />
            <DropdownMenu>
               <DropdownMenuTrigger asChild>
                  <Button
                     size="icon"
                     variant="ghost"
                     className="size-8"
                     aria-label={`${project.name} menu`}
                  >
                     <MoreHorizontal className="size-4" />
                  </Button>
               </DropdownMenuTrigger>
               <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                     variant="destructive"
                     onSelect={(event) => {
                        event.preventDefault();
                        deletion.request(project);
                     }}
                  >
                     {t('projects.delete')}
                  </DropdownMenuItem>
               </DropdownMenuContent>
            </DropdownMenu>
         </div>

         <DeleteProjectDialog deletion={deletion} />
      </div>
   );
}
