'use client';

import { DeleteIssueDialog, useIssueDeletion } from '@/components/common/issues/delete-issue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IssueDetail } from '@/data/issue-details';
import { Issue } from '@/data/issues';
import { patchBoardIssue } from '@/lib/issues';
import { setParent } from '@/lib/issue-tracking';
import { useIssueRuns } from '@/store/issue-runs-store';
import { useIssuesStore } from '@/store/issues-store';
import { GitPullRequestArrow, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AssigneeUser } from '../assignee-user';
import { PrioritySelector } from '../priority-selector';
import { StatusSelector } from '../status-selector';
import { IssueRefRow } from './content-blocks';
import { CustomStatusSelect } from './custom-status-select';
import { ExecutionLog } from './execution-log';
import { IssueCustomProperties } from './issue-custom-properties';
import { IssueDetailsSection } from './issue-details-section';
import { IssueLabelPicker } from './issue-label-picker';
import { IssueLinkedPullRequests } from './issue-linked-pull-requests';
import { IssueParentSection } from './issue-parent-section';
import { IssueQuickActions } from './issue-quick-actions';
import {
   IssueApprovalSection,
   IssueDependenciesSection,
   IssueGoalSection,
} from './issue-relations';
import { Section } from './panel-section';
import { ReviewerProperty } from './reviewer-property';
import { IssueUsageSection } from '@/components/common/usage/issue-usage-section';

interface IssuePropertiesPanelProps {
   issue: Issue;
   detail: IssueDetail;
   onDeleted?: () => void;
}

/** One labelled row of the properties block. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
   return (
      <div className="flex items-center justify-between gap-2">
         <span className="shrink-0 text-muted-foreground">{label}</span>
         <div className="flex min-w-0 items-center justify-end">{children}</div>
      </div>
   );
}

/**
 * Everything about this task that is not its text.
 *
 * The order is the order a person asks: what state is it in and who has it,
 * then what it belongs to, then what has been done to it, then what that cost,
 * and finally where it came from. Deleting stays at the bottom, away from
 * everything else, because it is the one action here that cannot be undone.
 */
export function IssuePropertiesPanel({ issue, detail, onDeleted }: IssuePropertiesPanelProps) {
   const t = useTranslations('issueDetail.properties');
   const deletion = useIssueDeletion(onDeleted);
   const updateIssue = useIssuesStore((state) => state.updateIssue);
   const { runs, upsert } = useIssueRuns(issue.id);

   const saveDueDate = (value: string) => {
      const dueDate = value === '' ? null : value;
      const previous = issue.dueDate;
      updateIssue(issue.id, { dueDate: dueDate ?? undefined });
      void patchBoardIssue(issue.id, { dueDate }).catch(() => {
         updateIssue(issue.id, { dueDate: previous });
         toast.error(t('saveFailed'));
      });
   };

   const saveStage = (value: string) => {
      const stage = value === '' ? null : Number(value);
      const previous = issue.stage ?? null;
      updateIssue(issue.id, { stage });
      // Stage is part of where a task sits in its parent's order, so it is
      // written through the hierarchy route rather than the issue patch.
      void setParent(issue.identifier, issue.parentId ?? null, stage).catch(() => {
         updateIssue(issue.id, { stage: previous });
         toast.error(t('saveFailed'));
      });
   };

   return (
      <>
         <div className="flex h-full min-h-0 flex-col">
            <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-x-hidden overflow-y-auto">
               <Section title={t('title')}>
                  <div className="flex flex-col gap-1.5">
                     <div className="-ml-1.5 flex items-center gap-1.5">
                        <StatusSelector status={issue.status} issueId={issue.id} />
                        <span>{issue.status.name}</span>
                     </div>
                     <CustomStatusSelect issue={issue} />
                     <div className="-ml-1.5 flex items-center gap-1.5">
                        <PrioritySelector priority={issue.priority} issueId={issue.id} />
                        <span>{issue.priority.name}</span>
                     </div>
                     <div className="mt-0.5 flex items-center gap-2">
                        <AssigneeUser user={issue.assignee} issueId={issue.id} />
                        <span>{issue.assignee ? issue.assignee.name : t('assign')}</span>
                     </div>
                     <ReviewerProperty issueRef={issue.identifier} />

                     <Row label={t('dueDate')}>
                        <Input
                           type="date"
                           aria-label={t('dueDate')}
                           className="h-7 w-36"
                           defaultValue={issue.dueDate ? issue.dueDate.slice(0, 10) : ''}
                           onChange={(event) => saveDueDate(event.target.value)}
                        />
                     </Row>

                     <Row label={t('stage')}>
                        <Input
                           type="number"
                           min={0}
                           aria-label={t('stage')}
                           placeholder={t('noStageValue')}
                           className="h-7 w-20"
                           defaultValue={issue.stage ?? ''}
                           onBlur={(event) => saveStage(event.target.value)}
                        />
                     </Row>

                     <Row label={t('labels')}>
                        <IssueLabelPicker issueRef={issue.identifier} />
                     </Row>
                  </div>
               </Section>

               <IssueCustomProperties issueRef={issue.identifier} />

               {issue.project && (
                  <Section title={t('project')}>
                     <div className="flex items-center gap-2">
                        <issue.project.icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{issue.project.name}</span>
                     </div>
                     {detail.milestone && (
                        <div className="mt-1.5 flex items-center gap-2 pl-6 text-muted-foreground">
                           <span className="size-2 shrink-0 rotate-45 border border-status-warning" />
                           <span className="truncate">{detail.milestone}</span>
                        </div>
                     )}
                  </Section>
               )}

               <IssueParentSection issue={issue} />
               <IssueQuickActions issueRef={issue.identifier} />
               <IssueApprovalSection issue={issue} />
               <ExecutionLog issueId={issue.id} runs={runs} onRunsChanged={upsert} />
               <IssueUsageSection issueId={issue.id} />
               <IssueGoalSection issue={issue} />
               <IssueDependenciesSection issue={issue} />
               <IssueLinkedPullRequests issueRef={issue.identifier} />

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
                           <div key={pr.id} className="flex min-w-0 items-center gap-2">
                              <GitPullRequestArrow
                                 className={
                                    'size-3.5 shrink-0 ' +
                                    (pr.status === 'merged'
                                       ? 'text-review-approved'
                                       : 'text-status-info')
                                 }
                              />
                              <span className="shrink-0 text-muted-foreground">{pr.id}</span>
                              <span className="truncate">{pr.title}</span>
                              <span className="ml-auto shrink-0 rounded bg-accent px-1.5 py-0.5 uppercase tracking-wide text-muted-foreground">
                                 {pr.status}
                              </span>
                           </div>
                        ))}
                     </div>
                  </Section>
               )}

               <IssueDetailsSection issue={issue} />
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
