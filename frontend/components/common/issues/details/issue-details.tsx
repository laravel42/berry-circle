'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getIssueDetail } from '@/data/issue-details';
import { useDetailDrawerClose, useInDetailDrawer } from '@/components/layout/detail-drawer-context';
import { WORKSPACE_SLUG } from '@/lib/config';
import { getBoardIssue } from '@/lib/issues';
import { forgetIssue, rememberIssue } from '@/lib/recent-issues';
import { cn } from '@/lib/utils';
import { useIssueViewStore } from '@/store/issue-view-store';
import { useIssuesStore } from '@/store/issues-store';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityCommentComposer, ActivityFeedList, useIssueActivity } from './activity-feed';
import { FindInIssue } from './find-in-issue';
import { IssueArtifacts } from './issue-artifacts';
import { IssueAttachments } from './issue-attachments';
import { IssueDescription } from './issue-description';
import { IssuePropertiesPanel } from './issue-properties-panel';
import { IssueQuickActions } from './issue-quick-actions';
import { IssueReactions } from './issue-reactions';
import { IssueReviews } from './issue-reviews';
import { IssueSubscription } from './issue-subscription';
import { IssueTitle } from './issue-title';
import { SubIssues } from './sub-issues';

/**
 * One task, in full.
 *
 * Three things here are about *arriving* rather than about the task: the URL
 * is rewritten to the task's own key so a link copied from here is readable
 * and stable, a `#comment-…` fragment takes the reader to that message, and
 * the visit is written to the recent list the rail reads. All three exist
 * because a task is usually reached from somewhere else — a search, an inbox
 * row, a message from a colleague — and arriving should leave you oriented.
 */
export default function IssueDetails() {
   const t = useTranslations('issueDetail.state');
   const { orgId, issueId } = useParams<{ orgId: string; issueId: string }>();
   const org = orgId ?? WORKSPACE_SLUG;
   const { issues, addIssue } = useIssuesStore();
   const inDrawer = useInDetailDrawer();
   const closeDrawer = useDetailDrawerClose();
   const router = useRouter();

   const sidebarOpen = useIssueViewStore((state) => state.sidebarOpen);
   const scrollMemory = useIssueViewStore((state) => state.scroll);
   const rememberScroll = useIssueViewStore((state) => state.rememberScroll);

   const [fetching, setFetching] = useState(true);
   const [missing, setMissing] = useState(false);
   const [highlighted, setHighlighted] = useState<string | null>(null);
   const scroller = useRef<HTMLDivElement>(null);
   const pane = useRef<HTMLDivElement>(null);
   const hadIssue = useRef(false);

   const issue = useMemo(
      () =>
         issues.find((candidate) => candidate.identifier === issueId || candidate.id === issueId),
      [issues, issueId]
   );

   const detail = useMemo(() => (issue ? getIssueDetail(issue) : null), [issue]);

   const afterDelete = useCallback(() => {
      if (closeDrawer) {
         closeDrawer();
         return;
      }
      router.push(`/${org}/my-issues`);
   }, [closeDrawer, router, org]);

   // Fetch when the store has never heard of this reference — which is the
   // normal case for a link followed from outside the board.
   useEffect(() => {
      if (!issueId) return;
      if (issue) {
         setFetching(false);
         setMissing(false);
         return;
      }
      let cancelled = false;
      setFetching(true);
      void getBoardIssue(issueId).then((fetched) => {
         if (cancelled) return;
         if (fetched) addIssue(fetched);
         else {
            setMissing(true);
            forgetIssue(issueId);
         }
         setFetching(false);
      });
      return () => {
         cancelled = true;
      };
   }, [issue, issueId, addIssue]);

   // A uuid in the address bar is a working link and an unreadable one. Once
   // the task is known, the URL becomes its key — replace, not push, so Back
   // still goes where the reader came from.
   useEffect(() => {
      if (!issue || !issueId || issue.identifier === issueId || inDrawer) return;
      const hash = typeof window === 'undefined' ? '' : window.location.hash;
      router.replace(`/${org}/issue/${issue.identifier}${hash}`);
   }, [issue, issueId, org, router, inDrawer]);

   useEffect(() => {
      if (!issue) return;
      rememberIssue({ id: issue.id, identifier: issue.identifier, title: issue.title });
   }, [issue?.id, issue?.identifier, issue?.title, issue]);

   // Deleted while open — by someone else, or from another tab. The task page
   // of a task that no longer exists is a dead end, so it leaves.
   useEffect(() => {
      if (issue) {
         hadIssue.current = true;
         return;
      }
      if (hadIssue.current && !fetching) {
         hadIssue.current = false;
         afterDelete();
      }
   }, [issue, fetching, afterDelete]);

   // `#comment-<id>`: scroll to it and mark it, and do it again whenever the
   // fragment changes, because a second link to a second comment on the same
   // page changes nothing else.
   const goToHash = useCallback(() => {
      if (typeof window === 'undefined') return;
      const match = /^#comment-(.+)$/.exec(window.location.hash);
      if (!match) {
         setHighlighted(null);
         return;
      }
      const commentId = match[1] ?? '';
      setHighlighted(commentId);
      requestAnimationFrame(() => {
         pane.current
            ?.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`)
            ?.scrollIntoView({ block: 'center' });
      });
   }, []);

   useEffect(() => {
      goToHash();
      window.addEventListener('hashchange', goToHash);
      return () => window.removeEventListener('hashchange', goToHash);
   }, [goToHash]);

   const activity = useIssueActivity(issue?.identifier ?? '', issue?.id);

   // The fragment may name a comment that had not loaded when the page did.
   useEffect(() => {
      if (highlighted) goToHash();
   }, [activity.comments.length, highlighted, goToHash]);

   // Scroll position, restored on the way back in. Session-only, by design:
   // a two-day-old offset against an edited description lands nowhere.
   const issueRef = issue?.identifier ?? '';
   useEffect(() => {
      const element = scroller.current;
      if (!element || !issueRef) return;
      const saved = scrollMemory[issueRef];
      if (saved) element.scrollTop = saved;
      // Only on arrival at a task: re-running this on every remembered scroll
      // would fight the reader for the scrollbar.
      // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [issueRef]);

   if (fetching && !issue) {
      return (
         <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8 sm:px-8" aria-busy="true">
            <span className="sr-only">{t('loading')}</span>
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
         </div>
      );
   }

   if (!issue) {
      return (
         <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <BerryMark size="lg" tone="neutral" state="crossed" label={t('notFoundTitle')} />
            <h1 className="mt-5 font-display tracking-[-0.025em]">{t('notFoundTitle')}</h1>
            <p className="mt-2 max-w-sm leading-relaxed text-muted-foreground">
               {missing ? t('notFoundBody', { identifier: issueId ?? '' }) : t('removed')}
            </p>
            <Button variant="outline" className="mt-6" asChild>
               <Link href={`/${org}/my-issues`}>{t('back')}</Link>
            </Button>
         </div>
      );
   }

   return (
      <div
         ref={pane}
         className={cn(
            'relative h-full min-h-0 w-full overflow-hidden bg-container',
            inDrawer ? 'grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto]' : 'flex'
         )}
      >
         <FindInIssue scope={pane} />

         <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
            <div
               ref={scroller}
               onScroll={(event) => rememberScroll(issueRef, event.currentTarget.scrollTop)}
               className="min-h-0 flex-1 overflow-y-auto"
            >
               <div className="mx-auto max-w-3xl px-6 py-6 pb-4 sm:px-8 sm:py-8">
                  <IssueTitle issue={issue} />

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                     <IssueReactions issueRef={issue.identifier} />
                     <div className="ml-auto flex items-center gap-2">
                        <IssueSubscription issueRef={issue.identifier} />
                     </div>
                  </div>

                  <IssueDescription
                     issueId={issue.id}
                     issueRef={issue.identifier}
                     description={issue.description}
                  />

                  <SubIssues issue={issue} />

                  <IssueAttachments issueRef={issue.identifier} />
                  <IssueArtifacts issueRef={issue.identifier} />
                  <IssueReviews issueRef={issue.identifier} />

                  <div className="mt-4">
                     <ActivityFeedList
                        comments={activity.comments}
                        events={activity.events}
                        runs={activity.runs}
                        error={activity.error}
                        issueRef={issue.identifier}
                        highlightedCommentId={highlighted}
                        onCommentChanged={activity.replaceComment}
                        onCommentDeleted={activity.removeComment}
                        onCommentPosted={activity.addComment}
                        onRunChanged={activity.upsertRun}
                     />
                  </div>
               </div>
            </div>

            <div className="relative z-10 shrink-0 border-t border-border/60 bg-container">
               <div className="mx-auto w-full max-w-3xl px-6 pt-5 pb-8 sm:px-8">
                  <ActivityCommentComposer
                     issueRef={issue.identifier}
                     onPosted={activity.addComment}
                     className="border-0 bg-transparent p-0 sm:px-0"
                  />
               </div>
            </div>
         </div>

         {sidebarOpen ? (
            <aside
               className={cn(
                  'hidden h-full min-w-0 flex-col overflow-hidden border-l bg-muted/15 px-5 pt-6 pb-3.5 lg:flex',
                  inDrawer ? 'lg:w-[221px] lg:shrink-0' : 'w-[292px] shrink-0'
               )}
            >
               <div className="mb-3 flex justify-end">
                  <IssueQuickActions issueRef={issue.identifier} />
               </div>
               <IssuePropertiesPanel
                  issue={issue}
                  detail={detail ?? getIssueDetail(issue)}
                  onDeleted={afterDelete}
               />
            </aside>
         ) : null}
      </div>
   );
}
