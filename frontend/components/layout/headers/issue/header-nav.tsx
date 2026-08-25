'use client';

import { CyclePlayIcon } from '@/components/common/cycles/cycle-icon';
import { Button } from '@/components/ui/button';
import { getCycleById } from '@/data/cycles';
import { useIssuesStore } from '@/store/issues-store';
import { ChevronDown, ChevronRight, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/**
 * Issue page header: breadcrumb (cycle › identifier + title) and previous /
 * next navigation across the issue list.
 */
export default function HeaderNav() {
   const { orgId, issueId } = useParams<{ orgId: string; issueId: string }>();
   const { issues } = useIssuesStore();

   const index = issues.findIndex((candidate) => candidate.identifier === issueId);
   const issue = index >= 0 ? issues[index] : undefined;
   const cycle = issue?.cycleId ? getCycleById(issue.cycleId) : undefined;

   const previousIssue = index > 0 ? issues[index - 1] : undefined;
   const nextIssue = index >= 0 && index < issues.length - 1 ? issues[index + 1] : undefined;

   return (
      <div className="w-full flex justify-between items-center border-b py-1.5 px-6 h-10 gap-4">
         <div className="flex items-center gap-2 min-w-0">
            {cycle && (
               <>
                  <span className="hidden sm:flex items-center gap-1.5 shrink-0 text-muted-foreground">
                     <CyclePlayIcon className="size-3.5" />
                     {cycle.name}
                  </span>
                  <ChevronRight className="size-3.5 text-muted-foreground shrink-0" />
               </>
            )}
            {issue && (
               <>
                  <span className="min-w-0 truncate">
                     <span className="font-medium text-muted-foreground mr-1.5">
                        {issue.identifier}
                     </span>
                     <span className="font-medium">{issue.title}</span>
                  </span>
               </>
            )}
         </div>

         <div className="flex items-center gap-1 shrink-0">
            {index >= 0 && (
               <span className="text-muted-foreground mr-1">
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
