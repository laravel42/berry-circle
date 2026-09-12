'use client';

import { Issue } from '@/data/issues';
import { listSquads } from '@/lib/squads';
import { useAgentsStore } from '@/store/agents-store';
import { useSessionStore } from '@/store/session-store';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';

export const MY_ISSUES_TABS = ['all', 'assigned', 'created', 'agents'] as const;
export type MyIssuesTab = (typeof MY_ISSUES_TABS)[number];

/** Default Issues tab when the URL omits `?tab=`. */
export const DEFAULT_MY_ISSUES_TAB: MyIssuesTab = 'all';

/** Shared tab state (URL-backed) between the header and the page body. */
export function useMyIssuesTab() {
   const [tab, setTab] = useQueryState(
      'tab',
      parseAsStringLiteral(MY_ISSUES_TABS).withDefault(DEFAULT_MY_ISSUES_TAB)
   );
   const activeTab = tab ?? DEFAULT_MY_ISSUES_TAB;
   return [activeTab, setTab] as const;
}

export interface MyIssuesScope {
   /** The signed-in person, for "assigned to me" and "created by me". */
   userId: string;
   /** Agents whose work counts as this person's: their agents and their squads'. */
   agentIds: Set<string>;
}

/**
 * The agents this person's tab should cover.
 *
 * An agent belongs to someone through a squad, so the roster of every squad
 * they are in counts, and so does every agent in the workspace they can assign
 * to — a workspace is one team's, and an agent nobody can see is not in the
 * list to begin with.
 */
export function useMyIssuesScope(): MyIssuesScope {
   const userId = useSessionStore((state) => state.user?.id ?? '');
   const agents = useAgentsStore((state) => state.agents);
   const [squadAgentIds, setSquadAgentIds] = useState<string[]>([]);

   useEffect(() => {
      if (!userId) return;
      let cancelled = false;
      void listSquads()
         .then((squads) => {
            if (cancelled) return;
            const mine = squads.filter(
               (squad) =>
                  !squad.archivedAt &&
                  squad.members.some((member) => member.type === 'user' && member.id === userId)
            );
            setSquadAgentIds(
               mine.flatMap((squad) => [
                  squad.leaderAgentId,
                  ...squad.members
                     .filter((member) => member.type === 'agent')
                     .map((member) => member.id),
               ])
            );
         })
         .catch(() => undefined);
      return () => {
         cancelled = true;
      };
   }, [userId]);

   return useMemo(
      () => ({
         userId,
         agentIds: new Set([...agents.map((agent) => agent.id), ...squadAgentIds]),
      }),
      [userId, agents, squadAgentIds]
   );
}

const isAgentAssignee = (issue: Issue): boolean => issue.assignee?.role === 'Application';

/** Issues shown by each Issues actor tab. */
export function scopeMyIssues(issues: Issue[], tab: MyIssuesTab, scope: MyIssuesScope): Issue[] {
   switch (tab) {
      case 'assigned':
         return issues.filter((issue) => issue.assignee?.id === scope.userId);
      case 'created':
         return issues.filter((issue) => issue.creator?.id === scope.userId);
      case 'agents':
         return issues.filter(
            (issue) =>
               isAgentAssignee(issue) &&
               (issue.assignee ? scope.agentIds.has(issue.assignee.id) : false)
         );
      case 'all':
      default:
         return issues;
   }
}
