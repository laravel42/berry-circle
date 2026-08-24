import type { Priority } from '@/data/priorities';
import { priorities } from '@/data/priorities';
import type { Status } from '@/data/status';
import { status } from '@/data/status';
import type { User } from '@/data/users';

/** API `IssueStatus` → UI status ids. */
export const STATUS_BY_API: Record<string, string> = {
   backlog: 'backlog',
   todo: 'to-do',
   inProgress: 'in-progress',
   inReview: 'in-review',
   done: 'done',
   blocked: 'blocked',
   cancelled: 'cancelled',
};

/** UI status ids → API `IssueStatus`. */
export const API_STATUS_BY_UI: Record<string, string> = {
   'backlog': 'backlog',
   'to-do': 'todo',
   'in-progress': 'inProgress',
   'in-review': 'inReview',
   'done': 'done',
   'blocked': 'blocked',
   'cancelled': 'cancelled',
};

/** API `IssuePriority` → Circle priority ids. */
export const PRIORITY_BY_API: Record<string, string> = {
   none: 'no-priority',
   urgent: 'urgent',
   high: 'high',
   medium: 'medium',
   low: 'low',
};

/** Circle priority ids → API `IssuePriority`. */
export const API_PRIORITY_BY_UI: Record<string, string> = {
   'no-priority': 'none',
   'urgent': 'urgent',
   'high': 'high',
   'medium': 'medium',
   'low': 'low',
};

const PROJECT_STATUS_BY_API: Record<string, string> = {
   planned: 'to-do',
   active: 'in-progress',
   paused: 'paused',
   completed: 'done',
   cancelled: 'cancelled',
};

/** UI status ids → API `ProjectStatus`. */
export const API_PROJECT_STATUS_BY_UI: Record<string, string> = {
   'to-do': 'planned',
   'in-progress': 'active',
   'paused': 'paused',
   'done': 'completed',
   'cancelled': 'cancelled',
};

export function catalogStatus(id: string): Status | undefined {
   return status.find((entry) => entry.id === id) ?? status.find((entry) => entry.id === 'backlog');
}

export function catalogPriority(id: string): Priority | undefined {
   return (
      priorities.find((entry) => entry.id === id) ??
      priorities.find((entry) => entry.id === 'no-priority')
   );
}

export function uiStatusFromApi(value: string): Status | undefined {
   return catalogStatus(STATUS_BY_API[value] ?? 'backlog');
}

export function uiPriorityFromApi(value: string): Priority | undefined {
   return catalogPriority(PRIORITY_BY_API[value] ?? 'no-priority');
}

export function apiStatusFromUi(id: string): string {
   return API_STATUS_BY_UI[id] ?? 'todo';
}

export function apiPriorityFromUi(id: string): string {
   return API_PRIORITY_BY_UI[id] ?? 'none';
}

export function apiProjectStatusFromUi(id: string): string {
   return API_PROJECT_STATUS_BY_UI[id] ?? 'planned';
}

export function uiStatusFromProjectApi(value: string): Status | undefined {
   return catalogStatus(PROJECT_STATUS_BY_API[value] ?? 'to-do');
}

export function toUiUser(actor: {
   id: string;
   name: string;
   avatarUrl?: string | null;
   email?: string;
   type?: string;
}): User {
   return {
      id: actor.id,
      name: actor.name,
      avatarUrl: actor.avatarUrl ?? '',
      email: actor.email ?? '',
      status: 'offline',
      role: actor.type === 'agent' ? 'Application' : 'Member',
      joinedDate: '',
      teamIds: [],
      timezone: 'UTC',
   };
}
