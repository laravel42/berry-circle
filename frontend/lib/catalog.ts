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

// ---------------------------------------------------------------------------
// Planning statuses

import type { BerryMarkState, BerryMarkTone } from '@/components/brand/berry-mark';

/** One glyph and one word for a status: what the mark draws and what the pill says. */
export interface StatusLook {
   label: string;
   tone: BerryMarkTone;
   state: BerryMarkState;
   pulse?: boolean;
}

/** A goal's four states, each read off its tasks rather than set by anyone. */
export const GOAL_STATUS: Record<string, StatusLook> = {
   planned: { label: 'Planned', tone: 'neutral', state: 'solid' },
   active: { label: 'In Progress', tone: 'working', state: 'solid' },
   blocked: { label: 'Blocked', tone: 'attention', state: 'hollow' },
   completed: { label: 'Done', tone: 'complete', state: 'solid' },
};

export const APPROVAL_STATUS: Record<string, StatusLook> = {
   pending: { label: 'Pending', tone: 'attention', state: 'hollow' },
   approved: { label: 'Approved', tone: 'complete', state: 'solid' },
   rejected: { label: 'Rejected', tone: 'danger', state: 'crossed' },
   expired: { label: 'Expired', tone: 'neutral', state: 'crossed' },
};

/** The look for a status, or a neutral hollow mark labelled with the raw value. */
export function statusLook(map: Record<string, StatusLook>, status: string): StatusLook {
   return map[status] ?? { label: status, tone: 'neutral', state: 'hollow' };
}
