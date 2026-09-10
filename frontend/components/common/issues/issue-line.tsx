'use client';

import { Issue } from '@/data/issues';
import { useDisplaySettingsStore } from '@/store/display-settings-store';
import { format } from 'date-fns';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AssigneeUser } from './assignee-user';
import { LabelBadge } from './label-badge';
import { PrioritySelector } from './priority-selector';
import { ProjectBadge } from './project-badge';
import { StatusSelector } from './status-selector';
import { motion } from 'motion/react';

import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { IssueContextMenu } from './issue-context-menu';
import { WORKSPACE_SLUG } from '@/lib/config';

export function IssueLine({ issue, layoutId = false }: { issue: Issue; layoutId?: boolean }) {
   const { orgId } = useParams<{ orgId: string }>();
   const { displayProperties } = useDisplaySettingsStore();

   return (
      <ContextMenu>
         <ContextMenuTrigger asChild>
            <motion.div
               {...(layoutId && { layoutId: `issue-line-${issue.identifier}` })}
               className={cn(
                  'group flex min-h-11 w-full items-center justify-start border-b border-border/45 px-4 transition-colors sm:px-6',
                  'hover:bg-accent/45 focus-within:bg-accent/45',
                  issue.status.category === 'started' && 'bg-status-info/[0.025]',
                  issue.status.category === 'completed' && 'bg-status-success/[0.025]',
                  issue.status.id === 'blocked' && 'bg-status-warning/[0.035]'
               )}
            >
               <div className="flex items-center gap-0.5">
                  {displayProperties.priority && (
                     <PrioritySelector priority={issue.priority} issueId={issue.id} />
                  )}
                  {displayProperties.id && (
                     <span className="mr-1 hidden w-[72px] shrink-0 truncate text-subtle-foreground sm:inline-block">
                        {issue.identifier}
                     </span>
                  )}
                  {displayProperties.status && (
                     <StatusSelector status={issue.status} issueId={issue.id} />
                  )}
               </div>
               <Link
                  href={`/${orgId ?? WORKSPACE_SLUG}/issue/${issue.identifier}`}
                  className="mr-1 ml-1 flex min-w-0 items-center justify-start rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
               >
                  <span className="truncate font-normal">{issue.title}</span>
               </Link>
               <div className="flex items-center justify-end gap-2 ml-auto sm:w-fit">
                  <div className="w-3 shrink-0"></div>
                  <div className="-space-x-5 hover:space-x-1 lg:space-x-1 items-center justify-end hidden sm:flex duration-200 transition-all">
                     {displayProperties.labels && <LabelBadge label={issue.labels} />}
                     {displayProperties.project && issue.project && (
                        <ProjectBadge project={issue.project} />
                     )}
                  </div>
                  {displayProperties.dueDate && issue.dueDate && (
                     <span className="hidden shrink-0 text-status-warning sm:inline-block">
                        due {format(new Date(issue.dueDate), 'MMM dd')}
                     </span>
                  )}
                  {displayProperties.created && (
                     <span className="text-muted-foreground shrink-0 hidden sm:inline-block">
                        {format(new Date(issue.createdAt), 'MMM dd')}
                     </span>
                  )}
                  {displayProperties.assignee && (
                     <AssigneeUser user={issue.assignee} issueId={issue.id} />
                  )}
               </div>
            </motion.div>
         </ContextMenuTrigger>
         <IssueContextMenu issueId={issue.id} />
      </ContextMenu>
   );
}
