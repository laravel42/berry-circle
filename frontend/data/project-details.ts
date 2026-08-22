import { ContentBlock } from './issue-details';
import { User } from './users';

/* -------------------------------------------------------------------------- */
/*                                 Interfaces                                 */
/* -------------------------------------------------------------------------- */

export interface ProjectMilestone {
   id: string;
   name: string;
   targetDate?: string;
   completed: boolean;
}

export type ProjectUpdateHealth = 'on-track' | 'at-risk' | 'off-track';

export const projectUpdateHealthLabel: Record<ProjectUpdateHealth, string> = {
   'on-track': 'On track',
   'at-risk': 'At risk',
   'off-track': 'Off track',
};

export const projectUpdateHealthColor: Record<ProjectUpdateHealth, string> = {
   'on-track': '#4cb782',
   'at-risk': '#f2c94c',
   'off-track': '#eb5757',
};

/** A posted project update (the "Activity" tab timeline). */
export interface ProjectUpdate {
   id: string;
   author: User;
   date: string; // ISO date
   health: ProjectUpdateHealth;
   blocks: ContentBlock[];
}

/** Lightweight activity event ("x added themselves as a member…"). */
export interface ProjectActivityEvent {
   id: string;
   user: User;
   date: string;
   text: string;
}

export interface ProjectResource {
   label: string;
   url: string;
}

export interface ProjectDetail {
   projectId: string;
   /** One-line summary shown under the project name. */
   summary: string;
   description: ContentBlock[];
   resources: ProjectResource[];
   milestones: ProjectMilestone[];
   updates: ProjectUpdate[];
   activity: ProjectActivityEvent[];
}

/* -------------------------------------------------------------------------- */
/*                                   Access                                   */
/* -------------------------------------------------------------------------- */

/**
 * Detail for a project. Demo content was stripped with the mock data layer;
 * real project overviews arrive from the gateway, so until then every
 * project detail boots empty.
 */
export function getProjectDetail(projectId: string): ProjectDetail {
   return {
      projectId,
      summary: '',
      description: [],
      resources: [],
      milestones: [],
      updates: [],
      activity: [],
   };
}
