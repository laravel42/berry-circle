'use client';

import { getIssueDetail } from '@/data/issue-details';
import { getBoardIssue } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Paperclip } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo } from 'react';
import { ActivityCommentComposer, ActivityFeedList, useIssueActivity } from './activity-feed';
import { IssueArtifacts } from './issue-artifacts';
import { IssueReviews } from './issue-reviews';
import { IssueAttachments } from './issue-attachments';
import { IssueDescriptionEditor } from './issue-description-editor';
import { IssuePropertiesPanel } from './issue-properties-panel';
import { IssueQuickActions } from './issue-quick-actions';
import { IssueReactions } from './issue-reactions';
import { IssueSubscription } from './issue-subscription';
import { SubIssues } from './sub-issues';
import { useDetailDrawerClose, useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { WORKSPACE_SLUG } from '@/lib/config';
import { cn } from '@/lib/utils';

/** Issue detail page: description, activity, properties, and review context. */
export default function IssueDetails() {
   const { orgId, issueId } = useParams<{ orgId: string; issueId: string }>();
   const { issues, addIssue } = useIssuesStore();
   const inDrawer = useInDetailDrawer();
   const closeDrawer = useDetailDrawerClose();
   const router = useRouter();

   const afterDelete = useCallback(() => {
      if (closeDrawer) {
         closeDrawer();
         return;
      }
      router.push(`/${orgId ?? WORKSPACE_SLUG}/my-issues`);
   }, [closeDrawer, router, orgId]);

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

   const activityFeed = useIssueActivity(issue?.identifier ?? issueId ?? '', issue?.id ?? issueId);

   if (!issue) {
      return (
         <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <BerryMark size="lg" tone="neutral" state="crossed" label="Task unavailable" />
            <h1 className="mt-5 font-display tracking-[-0.025em]">Task unavailable.</h1>
            <p className="mt-2 max-w-sm leading-relaxed text-muted-foreground">
               {issueId} is not in this workspace. Return to the queue and choose another issue.
            </p>
            <Button variant="outline" className="mt-6" asChild>
               <Link href={`/${orgId ?? WORKSPACE_SLUG}/my-issues`}>back to tasks</Link>
            </Button>
         </div>
      );
   }

   return (
      <div
         className={cn(
            'h-full min-h-0 w-full overflow-hidden bg-container',
            inDrawer ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]' : 'flex'
         )}
      >
         {/* Main column */}
         <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto">
               <div className="mx-auto max-w-3xl px-6 py-6 pb-4 sm:px-8 sm:py-8">
                  <h1 className="text-balance font-display leading-[1.08] tracking-[-0.025em]">
                     {issue.title}
                  </h1>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                     <IssueReactions issueRef={issue.identifier} />
                     <div className="ml-auto flex items-center gap-2">
                        <IssueQuickActions issueRef={issue.identifier} />
                        <IssueSubscription issueRef={issue.identifier} />
                     </div>
                  </div>

                  <>
                     <IssueDescriptionEditor issueId={issue.id} description={issue.description} />
                     <SubIssues issue={issue} />

                     <IssueAttachments issueRef={issue?.identifier ?? issueId ?? ''} />
                     <IssueArtifacts issueRef={issue?.identifier ?? issueId ?? ''} />
                     <IssueReviews issueRef={issue?.identifier ?? issueId ?? ''} />

                     <div className="mt-4">
                        <div className="flex items-center gap-1 pb-1.5 text-muted-foreground">
                           <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              aria-label="Attach file"
                           >
                              <Paperclip className="size-4" />
                           </Button>
                        </div>
                        <ActivityFeedList items={activityFeed.items} error={activityFeed.error} />
                     </div>
                  </>
               </div>
            </div>

            <div className="relative z-10 shrink-0 border-t border-border/60 bg-container">
               <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-8 sm:px-8">
                  <ActivityCommentComposer
                     draft={activityFeed.draft}
                     setDraft={activityFeed.setDraft}
                     submitComment={activityFeed.submitComment}
                     className="border-0 bg-transparent p-0 sm:px-0"
                  />
               </div>
            </div>
         </div>

         {/* Properties sidebar */}
         <aside
            className={cn(
               'hidden h-full min-w-0 flex-col overflow-hidden border-l bg-muted/15 px-5 pt-6 pb-3.5 lg:flex',
               inDrawer ? 'lg:w-[221px] lg:shrink-0' : 'w-[292px] shrink-0'
            )}
         >
            <IssuePropertiesPanel
               issue={issue}
               detail={detail ?? getIssueDetail(issue)}
               onDeleted={afterDelete}
            />
         </aside>
      </div>
   );
}
