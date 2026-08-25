'use client';

import { DeleteIssueDialog, useIssueDeletion } from '@/components/common/issues/delete-issue';
import { CyclePlayIcon } from '@/components/common/cycles/cycle-icon';
import { Button } from '@/components/ui/button';
import { getCycleById } from '@/data/cycles';
import { IssueDetail } from '@/data/issue-details';
import { Issue } from '@/data/issues';
import { Ban, GitPullRequestArrow, Trash2 } from 'lucide-react';
import { AssigneeUser } from '../assignee-user';
import { PrioritySelector } from '../priority-selector';
import { StatusSelector } from '../status-selector';
import { IssueRefRow } from './content-blocks';

interface IssuePropertiesPanelProps {
   issue: Issue;
   detail: IssueDetail;
   onDeleted?: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
   return (
      <div>
         <div className="mb-2 pb-[7px] font-medium uppercase tracking-[0.14em] text-[var(--shell-text-dim)]">
            {title.toLowerCase()}
         </div>
         {children}
      </div>
   );
}

/**
 * Right sidebar of the issue page: editable properties (status, priority,
 * assignee), cycle, labels, project + milestone, relations and linked PRs.
 */
export function IssuePropertiesPanel({ issue, detail, onDeleted }: IssuePropertiesPanelProps) {
   const cycle = issue.cycleId ? getCycleById(issue.cycleId) : undefined;
   const deletion = useIssueDeletion(onDeleted);

   return (
      <>
         <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto">
         <Section title="Properties">
            <div className="flex flex-col gap-1.5">
               <div className="flex items-center gap-1.5 -ml-1.5">
                  <StatusSelector status={issue.status} issueId={issue.id} />
                  <span>{issue.status.name}</span>
               </div>
               <div className="flex items-center gap-1.5 -ml-1.5">
                  <PrioritySelector priority={issue.priority} issueId={issue.id} />
                  <span>{issue.priority.name}</span>
               </div>
               <div className="flex items-center gap-2 mt-0.5">
                  <AssigneeUser user={issue.assignee} issueId={issue.id} />
                  <span>{issue.assignee ? issue.assignee.name : 'Assign'}</span>
               </div>
               {cycle && (
                  <div className="flex items-center gap-2 mt-0.5">
                     <CyclePlayIcon className="size-4" />
                     <span>{cycle.name}</span>
                  </div>
               )}
            </div>
         </Section>

         {issue.project && (
            <Section title="Project">
               <div className="flex items-center gap-2">
                  <issue.project.icon className="size-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{issue.project.name}</span>
               </div>
               {detail.milestone && (
                  <div className="flex items-center gap-2 mt-1.5 pl-6 text-muted-foreground">
                     <span className="size-2 shrink-0 rotate-45 border border-status-warning" />
                     <span className="truncate">{detail.milestone}</span>
                  </div>
               )}
            </Section>
         )}

         {detail.blockedByIds && detail.blockedByIds.length > 0 && (
            <Section title="Blocked by">
               <div className="flex flex-col">
                  {detail.blockedByIds.map((identifier) => (
                     <div key={identifier} className="flex items-center gap-1.5 min-w-0">
                        <Ban className="size-3.5 shrink-0 text-status-warning" />
                        <IssueRefRow identifier={identifier} />
                     </div>
                  ))}
               </div>
            </Section>
         )}

         {detail.relatedIds && detail.relatedIds.length > 0 && (
            <Section title="Related">
               <div className="flex flex-col">
                  {detail.relatedIds.map((identifier) => (
                     <IssueRefRow key={identifier} identifier={identifier} />
                  ))}
               </div>
            </Section>
         )}

         {detail.prLinks && detail.prLinks.length > 0 && (
            <Section title="Diffs">
               <div className="flex flex-col gap-1">
                  {detail.prLinks.map((pr) => (
                     <div key={pr.id} className="flex items-center gap-2 min-w-0">
                        <GitPullRequestArrow
                           className={
                              'size-3.5 shrink-0 ' +
                              (pr.status === 'merged' ? 'text-review-approved' : 'text-status-info')
                           }
                        />
                        <span className="text-muted-foreground shrink-0">{pr.id}</span>
                        <span className="truncate">{pr.title}</span>
                        <span className="ml-auto shrink-0 uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent text-muted-foreground">
                           {pr.status}
                        </span>
                     </div>
                  ))}
               </div>
            </Section>
         )}
            </div>

            <div className="flex shrink-0 justify-end">
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 translate-x-[10px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete task"
                  onClick={() => deletion.request(issue)}
               >
                  <Trash2 className="size-4" />
               </Button>
            </div>
         </div>

         <DeleteIssueDialog deletion={deletion} />
      </>
   );
}
