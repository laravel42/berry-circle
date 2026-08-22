'use client';

import { Issue, issueCreatorIndex } from '@/data/issues';
import { currentUser } from '@/data/users';
import { parseAsStringLiteral, useQueryState } from 'nuqs';

export const MY_ISSUES_TABS = ['assigned', 'created', 'subscribed', 'activity'] as const;
export type MyIssuesTab = (typeof MY_ISSUES_TABS)[number];

export const MY_ISSUES_TAB_ITEMS: { label: string; value: MyIssuesTab }[] = [
   { label: 'Assigned', value: 'assigned' },
   { label: 'Created', value: 'created' },
   { label: 'Subscribed', value: 'subscribed' },
   { label: 'Activity', value: 'activity' },
];

/** The signed-in user. Placeholder until gateway identity lands. */
export const ME = currentUser;

/** Shared tab state (URL-backed) between the header and the page body. */
export function useMyIssuesTab() {
   return useQueryState('tab', parseAsStringLiteral(MY_ISSUES_TABS).withDefault('assigned'));
}

const isCreatedByMe = (issue: Issue): boolean => issueCreatorIndex(issue, 1) === 0;
const isSubscribed = (issue: Issue): boolean =>
   issue.assignee?.id === ME.id || isCreatedByMe(issue) || issueCreatorIndex(issue, 7) === 3;

/** Issues shown by each My issues tab. */
export function scopeMyIssues(issues: Issue[], tab: MyIssuesTab): Issue[] {
   switch (tab) {
      case 'assigned':
         return issues.filter((issue) => issue.assignee?.id === ME.id);
      case 'created':
         return issues.filter(isCreatedByMe);
      case 'subscribed':
         return issues.filter(isSubscribed);
      case 'activity':
      default:
         // "Activity" = everything I touch, most recent first.
         return issues
            .filter(isSubscribed)
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
   }
}
