'use client';

import { IssuePinButton } from '@/components/common/issues/details/issue-pin-button';
import { LiveAgentChip } from '@/components/common/issues/details/live-agent-chip';
import { Button } from '@/components/ui/button';
import { status as STATUSES } from '@/data/status';
import type { Issue } from '@/data/issues';
import { getBoardIssue } from '@/lib/issues';
import { useIssueRuns } from '@/store/issue-runs-store';
import { useIssueViewStore } from '@/store/issue-view-store';
import { useIssuesStore } from '@/store/issues-store';
import {
   Check,
   ChevronDown,
   ChevronUp,
   CornerUpLeft,
   PanelRight,
   PanelRightClose,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * The task header.
 *
 * It answers three things in one line: where this task sits, whether anything
 * is happening to it right now, and the two or three actions a reader takes
 * without scrolling — finish it, pin it, get the sidebar out of the way.
 *
 * The breadcrumb is not decoration. A task reached from search or from an
 * inbox row arrives with no context at all, and "which project is this" is the
 * first thing anybody asks.
 */
export default function HeaderNav() {
   const t = useTranslations('issueDetail.header');
   const { orgId, issueId } = useParams<{ orgId: string; issueId: string }>();
   const { issues, updateIssueStatus } = useIssuesStore();
   const sidebarOpen = useIssueViewStore((state) => state.sidebarOpen);
   const toggleSidebar = useIssueViewStore((state) => state.toggleSidebar);

   const index = issues.findIndex(
      (candidate) => candidate.identifier === issueId || candidate.id === issueId
   );
   const issue = index >= 0 ? issues[index] : undefined;
   const { activeRun, upsert } = useIssueRuns(issue?.id);

   const previousIssue = index > 0 ? issues[index - 1] : undefined;
   const nextIssue = index >= 0 && index < issues.length - 1 ? issues[index + 1] : undefined;

   const [parent, setParent] = useState<Issue | null>(null);
   useEffect(() => {
      if (!issue?.parentId) {
         setParent(null);
         return;
      }
      let cancelled = false;
      void getBoardIssue(issue.parentId).then((found) => {
         if (!cancelled) setParent(found ?? null);
      });
      return () => {
         cancelled = true;
      };
   }, [issue?.parentId]);

   const done = issue?.status.id === 'done';
   const markDone = () => {
      if (!issue) return;
      const target = STATUSES.find((entry) => entry.id === (done ? 'in-progress' : 'done'));
      if (target) updateIssueStatus(issue.id, target);
   };

   return (
      <div className="flex h-10 w-full items-center justify-between gap-4 border-b px-6 py-1.5">
         <div className="flex min-w-0 items-center gap-2">
            {issue ? (
               <>
                  <nav aria-label={t('breadcrumb')} className="flex min-w-0 items-center gap-1.5">
                     {issue.project ? (
                        <Link
                           href={`/${orgId}/project/${issue.project.id}/issues`}
                           className="max-w-[160px] truncate text-muted-foreground hover:underline"
                        >
                           {issue.project.name}
                        </Link>
                     ) : (
                        <span className="text-muted-foreground">{t('noProject')}</span>
                     )}
                     <span aria-hidden className="text-muted-foreground">
                        /
                     </span>
                     <span className="min-w-0 truncate">
                        <span className="mr-1.5 font-medium text-muted-foreground">
                           {issue.identifier}
                        </span>
                        <span className="font-medium">{issue.title}</span>
                     </span>
                  </nav>

                  {parent ? (
                     <Link
                        href={`/${orgId}/issue/${parent.identifier}`}
                        title={parent.title}
                        className="flex max-w-[200px] shrink-0 items-center gap-1 rounded bg-accent px-1.5 text-muted-foreground hover:underline"
                     >
                        <CornerUpLeft className="size-3 shrink-0" />
                        <span className="shrink-0">{t('parentOf')}</span>
                        <span className="min-w-0 truncate">{parent.identifier}</span>
                     </Link>
                  ) : null}
               </>
            ) : null}
         </div>

         <div className="flex shrink-0 items-center gap-1">
            <LiveAgentChip run={activeRun} onRunChanged={upsert} />

            {issue ? (
               <>
                  <Button variant="ghost" size="xs" onClick={markDone}>
                     <Check className="mr-1 size-3.5" />
                     {done ? t('markNotDone') : t('markDone')}
                  </Button>
                  <IssuePinButton issueId={issue.id} />
                  <Button
                     variant="ghost"
                     size="icon"
                     className="size-6"
                     aria-pressed={sidebarOpen}
                     aria-label={sidebarOpen ? t('hideSidebar') : t('showSidebar')}
                     title={sidebarOpen ? t('hideSidebar') : t('showSidebar')}
                     onClick={toggleSidebar}
                  >
                     {sidebarOpen ? (
                        <PanelRightClose className="size-4" />
                     ) : (
                        <PanelRight className="size-4" />
                     )}
                  </Button>
               </>
            ) : null}

            {index >= 0 && (
               <span className="mr-1 text-muted-foreground">
                  {index + 1} / {issues.length}
               </span>
            )}
            <Button
               variant="ghost"
               size="icon"
               className="size-6"
               disabled={!previousIssue}
               asChild={!!previousIssue}
            >
               {previousIssue ? (
                  <Link
                     href={`/${orgId}/issue/${previousIssue.identifier}`}
                     aria-label="Previous task"
                  >
                     <ChevronUp className="size-4" />
                  </Link>
               ) : (
                  <ChevronUp className="size-4" />
               )}
            </Button>
            <Button
               variant="ghost"
               size="icon"
               className="size-6"
               disabled={!nextIssue}
               asChild={!!nextIssue}
            >
               {nextIssue ? (
                  <Link href={`/${orgId}/issue/${nextIssue.identifier}`} aria-label="Next task">
                     <ChevronDown className="size-4" />
                  </Link>
               ) : (
                  <ChevronDown className="size-4" />
               )}
            </Button>
         </div>
      </div>
   );
}
