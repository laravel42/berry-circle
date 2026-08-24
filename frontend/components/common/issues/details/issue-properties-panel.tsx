'use client';

import { CyclePlayIcon } from '@/components/common/cycles/cycle-icon';
import { Button } from '@/components/ui/button';
import { getCycleById } from '@/data/cycles';
import { IssueDetail } from '@/data/issue-details';
import { Issue } from '@/data/issues';
import { useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { BerryApiError } from '@/lib/api';
import { pickRunnableAgent } from '@/lib/agents';
import { WORKSPACE_SLUG } from '@/lib/config';
import { createIssueRun } from '@/lib/runs';
import { useAgentsStore } from '@/store/agents-store';
import { Ban, GitPullRequestArrow, Plus } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AssigneeUser } from '../assignee-user';
import { LabelBadge } from '../label-badge';
import { PrioritySelector } from '../priority-selector';
import { StatusSelector } from '../status-selector';
import { IssueRefRow } from './content-blocks';

interface IssuePropertiesPanelProps {
   issue: Issue;
   detail: IssueDetail;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
   return (
      <div>
         <h3 className="mb-2 text-xs text-subtle-foreground">{title.toLowerCase()}</h3>
         {children}
      </div>
   );
}

/**
 * Right sidebar of the issue page: editable properties (status, priority,
 * assignee), cycle, labels, project + milestone, relations and linked PRs.
 */
export function IssuePropertiesPanel({ issue, detail }: IssuePropertiesPanelProps) {
   const cycle = issue.cycleId ? getCycleById(issue.cycleId) : undefined;
   const inDrawer = useInDetailDrawer();
   const { orgId } = useParams<{ orgId: string }>();
   const router = useRouter();
   const agents = useAgentsStore((state) => state.agents);
   const [starting, setStarting] = useState(false);

   const startRun = async () => {
      const agent = pickRunnableAgent(agents);
      if (!agent) {
         toast.error('No agent is available');
         return;
      }
      setStarting(true);
      try {
         const run = await createIssueRun(issue.id, {
            agentId: agent.id,
            instructions: issue.description || undefined,
         });
         toast.success(`Run started with ${agent.name}`);
         router.push(`/${orgId ?? WORKSPACE_SLUG}/runs?run=${run.id}`);
      } catch (error) {
         toast.error(error instanceof BerryApiError ? error.message : 'Could not start a run');
      } finally {
         setStarting(false);
      }
   };

   return (
      <div className="flex flex-col gap-7">
         <Section title="Properties">
            <div className="flex flex-col gap-1.5">
               <div className="flex items-center gap-1.5 -ml-1.5">
                  <StatusSelector status={issue.status} issueId={issue.id} />
                  <span className="text-xs">{issue.status.name}</span>
               </div>
               <div className="flex items-center gap-1.5 -ml-1.5">
                  <PrioritySelector priority={issue.priority} issueId={issue.id} />
                  <span className="text-xs">{issue.priority.name}</span>
               </div>
               <div className="flex items-center gap-2 mt-0.5">
                  <AssigneeUser user={issue.assignee} issueId={issue.id} />
                  <span className="text-xs">{issue.assignee ? issue.assignee.name : 'Assign'}</span>
               </div>
               {agents.length > 0 ? (
                  <Button
                     className="mt-2 w-fit"
                     size="sm"
                     variant="secondary"
                     disabled={starting}
                     onClick={() => void startRun()}
                  >
                     {starting ? 'starting…' : 'ask agent'}
                  </Button>
               ) : null}
               {cycle && (
                  <div className="flex items-center gap-2 mt-0.5">
                     <CyclePlayIcon className="size-4" />
                     <span className="text-sm">{cycle.name}</span>
                  </div>
               )}
            </div>
         </Section>

         {!inDrawer ? (
            <Section title="Labels">
               <div className="flex items-center flex-wrap gap-1.5">
                  <LabelBadge label={issue.labels} />
                  <Button
                     variant="ghost"
                     size="icon"
                     className="size-6 rounded-sm border"
                     aria-label="Add label"
                  >
                     <Plus className="size-3.5" />
                  </Button>
               </div>
            </Section>
         ) : null}

         {issue.project && (
            <Section title="Project">
               <div className="flex items-center gap-2 text-sm">
                  <issue.project.icon className="size-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{issue.project.name}</span>
               </div>
               {detail.milestone && (
                  <div className="flex items-center gap-2 text-sm mt-1.5 pl-6 text-muted-foreground">
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
                     <div key={pr.id} className="flex items-center gap-2 text-sm min-w-0">
                        <GitPullRequestArrow
                           className={
                              'size-3.5 shrink-0 ' +
                              (pr.status === 'merged' ? 'text-review-approved' : 'text-status-info')
                           }
                        />
                        <span className="text-muted-foreground shrink-0">{pr.id}</span>
                        <span className="truncate">{pr.title}</span>
                        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent text-muted-foreground">
                           {pr.status}
                        </span>
                     </div>
                  ))}
               </div>
            </Section>
         )}
      </div>
   );
}
