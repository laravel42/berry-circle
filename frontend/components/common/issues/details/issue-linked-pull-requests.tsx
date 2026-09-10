'use client';

import { subscribeWorkspaceEvents } from '@/lib/events';
import { GITHUB_EVENTS, loadIssuePullRequests, type LinkedPullRequest } from '@/lib/github';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/store/session-store';
import {
   CircleCheck,
   CircleDashed,
   CircleX,
   GitMerge,
   GitPullRequestArrow,
   GitPullRequestClosed,
   GitPullRequestDraft,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const STATE_LABEL: Record<LinkedPullRequest['state'], string> = {
   open: 'Open',
   draft: 'Draft',
   merged: 'Merged',
   closed: 'Closed',
};

function StateIcon({ state }: { state: LinkedPullRequest['state'] }) {
   const className = 'size-3.5 shrink-0';
   switch (state) {
      case 'merged':
         return <GitMerge className={cn(className, 'text-review-approved')} aria-hidden />;
      case 'closed':
         return <GitPullRequestClosed className={cn(className, 'text-status-danger')} aria-hidden />;
      case 'draft':
         return <GitPullRequestDraft className={cn(className, 'text-muted-foreground')} aria-hidden />;
      default:
         return <GitPullRequestArrow className={cn(className, 'text-status-info')} aria-hidden />;
   }
}

function ChecksSummary({ checks }: { checks: LinkedPullRequest['checks'] }) {
   if (checks.rollup === 'none') return null;
   const icon =
      checks.rollup === 'success' ? (
         <CircleCheck className="size-3.5 text-review-approved" aria-hidden />
      ) : checks.rollup === 'failure' ? (
         <CircleX className="size-3.5 text-status-danger" aria-hidden />
      ) : (
         <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
      );
   const words =
      checks.rollup === 'failure'
         ? `${checks.failed} of ${checks.total} checks failed`
         : checks.rollup === 'pending'
           ? `${checks.pending} of ${checks.total} checks running`
           : checks.rollup === 'success'
             ? `${checks.passed} of ${checks.total} checks passed`
             : `${checks.total} checks, no verdict`;
   const failing = checks.items.filter((check) =>
      ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(
         check.conclusion ?? ''
      )
   );
   return (
      <div className="mt-0.5 flex flex-col gap-0.5 text-muted-foreground">
         <span className="flex items-center gap-1.5">
            {icon}
            {words}
         </span>
         {failing.slice(0, 3).map((check) => (
            <span key={`${check.kind}-${check.name}`} className="truncate pl-5">
               {check.url ? (
                  <a href={check.url} target="_blank" rel="noreferrer" className="hover:underline">
                     {check.name}
                  </a>
               ) : (
                  check.name
               )}
            </span>
         ))}
      </div>
   );
}

/**
 * The pull requests GitHub has linked to this task, with their state and
 * checks.
 *
 * Self-contained: it reads the workspace from the session, fetches its own
 * data and listens for `github.pull_request.updated` on the workspace stream,
 * so the sidebar only has to place it. It renders nothing when the workspace
 * has switched the panel off or no pull request names the task.
 */
export function IssueLinkedPullRequests({ issueRef }: { issueRef: string }) {
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const [pullRequests, setPullRequests] = useState<LinkedPullRequest[]>([]);
   const [visible, setVisible] = useState(false);

   const load = useCallback(async () => {
      if (!workspaceId || !issueRef) return;
      try {
         const result = await loadIssuePullRequests(workspaceId, issueRef);
         setVisible(result.visible);
         setPullRequests(result.pullRequests);
      } catch {
         // A task page must not break over its sidebar extra; hide instead.
         setVisible(false);
         setPullRequests([]);
      }
   }, [workspaceId, issueRef]);

   useEffect(() => {
      void load();
   }, [load]);

   // Events name the issue by id and this page knows it by key, so any pull
   // request change in the workspace refetches. The read is one small query,
   // and it is the only way a check finishing shows without a reload.
   useEffect(
      () =>
         subscribeWorkspaceEvents((event) => {
            if (event.workspaceId && event.workspaceId !== workspaceId) return;
            if (event.type === GITHUB_EVENTS.pullRequest || event.type === GITHUB_EVENTS.settings) {
               void load();
            }
         }),
      [workspaceId, load]
   );

   if (!visible || pullRequests.length === 0) return null;

   return (
      <div className="flex flex-col gap-2">
         <h3 className="font-medium text-muted-foreground">Pull requests</h3>
         <ul className="flex flex-col gap-2">
            {pullRequests.map((pr) => (
               <li key={pr.id} className="min-w-0">
                  <a
                     href={pr.url}
                     target="_blank"
                     rel="noreferrer"
                     className="flex min-w-0 items-center gap-2 hover:underline"
                     title={`${pr.repoFullName}#${pr.number}`}
                  >
                     <StateIcon state={pr.state} />
                     <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
                     <span className="truncate">{pr.title || pr.headRef}</span>
                  </a>
                  <div className="flex flex-wrap items-center gap-x-2 pl-5 text-muted-foreground">
                     <span>{STATE_LABEL[pr.state]}</span>
                     <span className="truncate">{pr.repoFullName}</span>
                     {pr.closeIntent && pr.state !== 'merged' && <span>closes this task on merge</span>}
                  </div>
                  <div className="pl-0">
                     <ChecksSummary checks={pr.checks} />
                  </div>
               </li>
            ))}
         </ul>
      </div>
   );
}
