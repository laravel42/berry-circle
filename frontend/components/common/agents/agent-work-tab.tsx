'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { useIssuesStore } from '@/store/issues-store';

/**
 * The issues assigned to this agent.
 *
 * Assignments, not runs: the activity tab already answers "what has it done",
 * and the question this tab exists for is "what is it on the hook for", which
 * an issue answers and a finished run does not.
 */
export default function AgentWorkTab({ agentId }: { agentId: string }) {
   const { orgId } = useParams<{ orgId: string }>();
   const t = useTranslations('agentsChat.detail');
   const issues = useIssuesStore((state) => state.issues);

   const assigned = useMemo(
      () => issues.filter((issue) => issue.assignee?.id === agentId),
      [issues, agentId]
   );

   return (
      <div className="flex max-w-4xl flex-col gap-3 px-8 py-6">
         <h2 className="font-medium">{t('workTitle')}</h2>
         {assigned.length === 0 ? (
            <p className="text-muted-foreground">{t('workEmpty')}</p>
         ) : (
            <ul className="flex flex-col rounded-md border border-border">
               {assigned.map((issue) => {
                  const StatusIcon = issue.status.icon;
                  return (
                     <li key={issue.id} className="border-b border-border last:border-b-0">
                        <Link
                           href={`/${orgId}/issue/${issue.id}`}
                           className="flex items-center gap-3 px-3 py-2.5 hover:bg-sidebar/40"
                        >
                           <StatusIcon />
                           <span className="shrink-0 tabular-nums text-muted-foreground">
                              {issue.identifier}
                           </span>
                           <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                           <span className="shrink-0 text-muted-foreground">
                              {issue.status.name}
                           </span>
                        </Link>
                     </li>
                  );
               })}
            </ul>
         )}
      </div>
   );
}
