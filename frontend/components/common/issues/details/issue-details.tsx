'use client';

import { getIssueDetail } from '@/data/issue-details';
import { getBoardIssue } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Paperclip, Plus, SmilePlus } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo } from 'react';
import { AssigneeUser } from '../assignee-user';
import { ActivityCommentComposer, ActivityFeedList, useIssueActivity } from './activity-feed';
import { IssueDescriptionEditor } from './issue-description-editor';
import { IssuePropertiesPanel } from './issue-properties-panel';
import { useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { WORKSPACE_SLUG } from '@/lib/config';
import { cn } from '@/lib/utils';

/** Issue detail page: description, activity, properties, and review context. */
export default function IssueDetails() {
   const { orgId, issueId } = useParams<{ orgId: string; issueId: string }>();
   const { issues, addIssue } = useIssuesStore();
   const inDrawer = useInDetailDrawer();

   const issue = useMemo(
      () => issues.find((candidate) => candidate.identifier === issueId),
      [issues, issueId]
   );

   const detail = useMemo(() => (issue ? getIssueDetail(issue) : null), [issue]);

   useEffect(() => {
      if (issue || !issueId) return;
      let cancelled = false;
      void getBoardIssue(issueId).then((fetched) => {
         if (!cancelled && fetched) {
            addIssue(fetched);
         }
      });
      return () => {
         cancelled = true;
      };
   }, [issue, issueId, addIssue]);

   const activityFeed = useIssueActivity(issue?.identifier ?? issueId ?? '');

   if (!issue) {
      return (
         <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <BerryMark size="lg" tone="neutral" state="crossed" label="Issue unavailable" />
            <h1 className="mt-5 font-display text-3xl tracking-[-0.025em]">Issue unavailable.</h1>
            <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
               {issueId} is not in this workspace. Return to the queue and choose another issue.
            </p>
            <Button variant="outline" className="mt-6" asChild>
               <Link href={`/${orgId ?? WORKSPACE_SLUG}/my-issues`}>back to issues</Link>
            </Button>
         </div>
      );
   }

   const subIssues: typeof issues = [];

   return (
      <div
         className={cn(
            'h-full min-h-0 w-full overflow-hidden bg-container',
            inDrawer ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,4fr)_minmax(0,1fr)]' : 'flex'
         )}
      >
         {/* Main column */}
         <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
               <div className="mx-auto max-w-3xl px-6 py-6 pb-4 sm:px-8 sm:py-8">
                  <h1 className="text-balance font-display text-4xl leading-[1.08] tracking-[-0.025em]">
                     {issue.title}
                  </h1>

                  <>
                     <IssueDescriptionEditor issueId={issue.id} description={issue.description} />

                     <div className="mt-3 flex items-center gap-1 text-muted-foreground">
                        <Button
                           variant="ghost"
                           size="icon"
                           className="size-8"
                           aria-label="Add reaction"
                        >
                           <SmilePlus className="size-4" />
                        </Button>
                        <Button
                           variant="ghost"
                           size="icon"
                           className="size-8"
                           aria-label="Attach file"
                        >
                           <Paperclip className="size-4" />
                        </Button>
                     </div>

                     <div className="mt-4">
                        {subIssues.length > 0 ? (
                           <>
                              <h2 className="mb-1 text-sm font-medium">
                                 sub-issues{' '}
                                 <span className="text-muted-foreground">
                                    {
                                       subIssues.filter(
                                          (subIssue) => subIssue.status.category === 'completed'
                                       ).length
                                    }
                                    /{subIssues.length}
                                 </span>
                              </h2>
                              <div className="flex flex-col border-t border-border/50">
                                 {subIssues.map((subIssue) => (
                                    <Link
                                       key={subIssue.id}
                                       href={`/${orgId ?? WORKSPACE_SLUG}/issue/${subIssue.identifier}`}
                                       className="flex items-center gap-2.5 h-10 px-1 border-b border-border/50 hover:bg-sidebar/50 text-sm min-w-0"
                                    >
                                       <subIssue.status.icon />
                                       <span className="text-muted-foreground shrink-0 text-xs font-medium">
                                          {subIssue.identifier}
                                       </span>
                                       <span className="truncate font-medium">
                                          {subIssue.title}
                                       </span>
                                       <span className="ml-auto shrink-0">
                                          <AssigneeUser
                                             user={subIssue.assignee}
                                             issueId={subIssue.id}
                                          />
                                       </span>
                                    </Link>
                                 ))}
                              </div>
                           </>
                        ) : (
                           <button className="flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
                              <Plus className="size-4" />
                              add sub-issues
                           </button>
                        )}
                     </div>

                     <ActivityFeedList items={activityFeed.items} />
                  </>
               </div>
            </div>

            <ActivityCommentComposer
               draft={activityFeed.draft}
               setDraft={activityFeed.setDraft}
               submitComment={activityFeed.submitComment}
               className="relative z-10 shrink-0 px-6 sm:px-8"
            />
         </div>

         {/* Properties sidebar */}
         <aside
            className={cn(
               'hidden h-full min-w-0 overflow-y-auto border-l bg-muted/15 px-5 py-6 lg:block',
               !inDrawer && 'w-80 shrink-0'
            )}
         >
            <IssuePropertiesPanel issue={issue} detail={detail ?? getIssueDetail(issue)} />
         </aside>
      </div>
   );
}
