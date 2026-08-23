'use client';

import { Issue } from '@/data/issues';
import { parseAsStringLiteral, useQueryState } from 'nuqs';

export const MY_ISSUES_TABS = ['all', 'members', 'agent'] as const;
export type MyIssuesTab = (typeof MY_ISSUES_TABS)[number];

export const MY_ISSUES_TAB_ITEMS: { label: string; value: MyIssuesTab }[] = [
   { label: 'All', value: 'all' },
   { label: 'Members', value: 'members' },
   { label: 'Agent', value: 'agent' },
];

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

const isAgentAssignee = (issue: Issue): boolean => issue.assignee?.role === 'Application';
const isMemberAssignee = (issue: Issue): boolean =>
   issue.assignee !== null && issue.assignee.role !== 'Application';

/** Issues shown by each Issues actor tab. */
export function scopeMyIssues(issues: Issue[], tab: MyIssuesTab): Issue[] {
   switch (tab) {
      case 'members':
         return issues.filter(isMemberAssignee);
      case 'agent':
         return issues.filter(isAgentAssignee);
      case 'all':
      default:
         return issues;
   }
}
