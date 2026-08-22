import { Priority } from './priorities';
import { Health, Project, projects } from './projects';
import { User } from './users';

export type InitiativeStatus = 'active' | 'planned' | 'completed';

export interface Initiative {
   id: string;
   name: string;
   description?: string;
   /** Emoji used as the initiative icon. */
   icon: string;
   status: InitiativeStatus;
   priority: Priority;
   owner?: User;
   /** Target label shown in the list ("Q3 2026", "Sep 30th", …). */
   target?: string;
   health: Health;
   projectIds: string[];
   createdAt: string;
}

export const INITIATIVE_STATUS_META: Record<
   InitiativeStatus,
   { label: string; color: string }
> = {
   active: { label: 'Active', color: '#f2c94c' },
   planned: { label: 'Planned', color: '#95a2b3' },
   completed: { label: 'Completed', color: '#5e6ad2' },
};

/** Workspace initiatives. Empty until the gateway provides them. */
export const initiatives: Initiative[] = [];

export function getInitiativeById(id: string): Initiative | undefined {
   return initiatives.find((initiative) => initiative.id === id);
}

export function getInitiativeProjects(initiative: Initiative): Project[] {
   return initiative.projectIds
      .map((id) => projects.find((project) => project.id === id))
      .filter((project): project is Project => Boolean(project));
}

/** Projects considered "completed" for the n / m counter. */
export function countCompletedProjects(initiative: Initiative): number {
   return getInitiativeProjects(initiative).filter(
      (project) => project.status.category === 'completed' || project.percentComplete >= 100
   ).length;
}
