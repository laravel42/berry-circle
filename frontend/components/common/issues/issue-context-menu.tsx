'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { BerryMark } from '@/components/brand/berry-mark';
import {
   ContextMenuContent,
   ContextMenuGroup,
   ContextMenuItem,
   ContextMenuSeparator,
   ContextMenuShortcut,
   ContextMenuSub,
   ContextMenuSubContent,
   ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { DeleteIssueDialog, useIssueDeletion } from '@/components/common/issues/delete-issue';
import { useIssueActions } from '@/components/common/issues/use-issue-actions';
import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { agentToUser } from '@/lib/agents';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import {
   BarChart3,
   CalendarClock,
   CircleCheck,
   ExternalLink,
   Folder,
   Link as LinkIcon,
   Link2,
   Pin,
   PinOff,
   Tag,
   Trash2,
   User,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

interface IssueContextMenuProps {
   issueId?: string;
}

/** How many sibling tasks a relation submenu offers before it stops listing. */
const RELATION_CHOICES = 8;

/**
 * The right-click menu on a row or a card: the fields people change without
 * opening anything, the ways out of the list, the relations, and delete.
 */
export function IssueContextMenu({ issueId }: IssueContextMenuProps) {
   const t = useTranslations('issueLists');
   const actions = useIssueActions(issueId);
   const issue = actions.issue;
   const deletion = useIssueDeletion();
   const { projects, members, labels } = actions;
   const agents = useAgentsStore((state) => state.agents);
   const issues = useIssuesStore((state) => state.issues);

   const agentPeople = useMemo(() => agents.map(agentToUser), [agents]);

   /* Candidates for a parent or an adopted sub-task: other tasks, nearest
      first. A full picker belongs on the task page; this is the quick path. */
   const relatives = useMemo(
      () => issues.filter((candidate) => candidate.id !== issue?.id).slice(0, RELATION_CHOICES),
      [issues, issue?.id]
   );

   return (
      <ContextMenuContent className="w-64">
         <ContextMenuGroup>
            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <CircleCheck className="mr-2 size-4" /> {t('display.status')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-48">
                  {status.map((entry) => {
                     const Icon = entry.icon;
                     return (
                        <ContextMenuItem key={entry.id} onClick={() => actions.setStatus(entry.id)}>
                           <Icon /> {entry.name}
                        </ContextMenuItem>
                     );
                  })}
               </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <User className="mr-2 size-4" /> {t('display.assignee')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-48">
                  <ContextMenuItem onClick={() => actions.setAssignee(null)}>
                     <User className="size-4" /> {t('filters.noAssignee')}
                  </ContextMenuItem>
                  {members.map((user) => (
                     <ContextMenuItem key={user.id} onClick={() => actions.setAssignee(user.id)}>
                        <Avatar className="size-4">
                           <AvatarImage src={user.avatarUrl} alt={user.name} />
                           <AvatarFallback>{user.name[0]}</AvatarFallback>
                        </Avatar>
                        {user.name}
                     </ContextMenuItem>
                  ))}
                  {agentPeople.map((agent) => (
                     <ContextMenuItem key={agent.id} onClick={() => actions.setAssignee(agent.id)}>
                        <BerryMark size="sm" tone="working" label={`${agent.name}, agent`} />
                        {agent.name}
                     </ContextMenuItem>
                  ))}
               </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <BarChart3 className="mr-2 size-4" /> {t('display.priority')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-48">
                  {priorities.map((priority) => (
                     <ContextMenuItem
                        key={priority.id}
                        onClick={() => actions.setPriority(priority.id)}
                     >
                        <priority.icon className="size-4" /> {priority.name}
                     </ContextMenuItem>
                  ))}
               </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <CalendarClock className="mr-2 size-4" /> {t('menu.dueDate')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-48">
                  <ContextMenuItem onClick={actions.setDueDateToday}>
                     {t('menu.today')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={actions.setDueDateTomorrow}>
                     {t('menu.tomorrow')}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={actions.setDueDateNextWeek}>
                     {t('menu.nextWeek')}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={actions.clearDueDate}>
                     {t('menu.clearDate')}
                  </ContextMenuItem>
               </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <Tag className="mr-2 size-4" /> {t('menu.labels')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-48">
                  {labels.map((label) => (
                     <ContextMenuItem key={label.id} onClick={() => actions.toggleLabel(label.id)}>
                        <span
                           className="inline-block size-3 rounded-full"
                           style={{ backgroundColor: label.color }}
                           aria-hidden="true"
                        />
                        {label.name}
                     </ContextMenuItem>
                  ))}
               </ContextMenuSubContent>
            </ContextMenuSub>

            <ContextMenuSub>
               <ContextMenuSubTrigger>
                  <Folder className="mr-2 size-4" /> {t('display.project')}
               </ContextMenuSubTrigger>
               <ContextMenuSubContent className="w-64">
                  <ContextMenuItem onClick={() => actions.setProject(null)}>
                     <Folder className="size-4" /> {t('filters.noProject')}
                  </ContextMenuItem>
                  {projects.slice(0, 8).map((project) => (
                     <ContextMenuItem
                        key={project.id}
                        onClick={() => actions.setProject(project.id)}
                     >
                        <project.icon className="size-4" /> {project.name}
                     </ContextMenuItem>
                  ))}
               </ContextMenuSubContent>
            </ContextMenuSub>
         </ContextMenuGroup>

         <ContextMenuSeparator />

         <ContextMenuItem onClick={actions.openInNewTab}>
            <ExternalLink className="size-4" /> {t('menu.openInNewTab')}
         </ContextMenuItem>
         <ContextMenuItem onClick={actions.togglePin}>
            {actions.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
            {actions.isPinned ? t('menu.unpin') : t('menu.pin')}
         </ContextMenuItem>
         <ContextMenuItem onClick={actions.copyLink}>
            <LinkIcon className="size-4" /> {t('menu.copyLink')}
            <ContextMenuShortcut>⌘L</ContextMenuShortcut>
         </ContextMenuItem>

         <ContextMenuSeparator />

         <ContextMenuSub>
            <ContextMenuSubTrigger>
               <Link2 className="mr-2 size-4" /> {t('menu.relations')}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-64">
               <ContextMenuItem onClick={() => actions.createSubIssue()}>
                  {t('menu.subIssue')}
               </ContextMenuItem>
               <ContextMenuSub>
                  <ContextMenuSubTrigger>{t('menu.setParent')}</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-64">
                     {relatives.map((candidate) => (
                        <ContextMenuItem
                           key={candidate.id}
                           onClick={() => actions.setParentIssue(candidate.id)}
                        >
                           <span className="text-muted-foreground">{candidate.identifier}</span>
                           <span className="truncate">{candidate.title}</span>
                        </ContextMenuItem>
                     ))}
                  </ContextMenuSubContent>
               </ContextMenuSub>
               <ContextMenuItem disabled={!issue?.parentId} onClick={() => actions.removeParent()}>
                  {t('menu.removeParent')}
               </ContextMenuItem>
               <ContextMenuSub>
                  <ContextMenuSubTrigger>{t('menu.addExisting')}</ContextMenuSubTrigger>
                  <ContextMenuSubContent className="w-64">
                     {relatives.map((candidate) => (
                        <ContextMenuItem
                           key={candidate.id}
                           onClick={() => actions.addExistingSubIssue(candidate.id)}
                        >
                           <span className="text-muted-foreground">{candidate.identifier}</span>
                           <span className="truncate">{candidate.title}</span>
                        </ContextMenuItem>
                     ))}
                  </ContextMenuSubContent>
               </ContextMenuSub>
            </ContextMenuSubContent>
         </ContextMenuSub>

         <ContextMenuSeparator />

         <ContextMenuItem
            variant="destructive"
            onSelect={(event) => {
               // The menu closes on select and would unmount the dialog with
               // it, so the default is prevented and the dialog opened instead.
               event.preventDefault();
               if (issue) deletion.request(issue);
            }}
         >
            <Trash2 className="size-4" /> {t('menu.delete')}
            <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
         </ContextMenuItem>

         <DeleteIssueDialog deletion={deletion} />
      </ContextMenuContent>
   );
}
