import { Priority } from './priorities';
import { Health, Project, projects } from './projects';
import { User } from './users';

export type InitiativeStatus = 'active' | 'planned' | 'completed';

export const INITIATIVE_STATUS_META: Record<InitiativeStatus, { label: string; color: string }> = {
   active: { label: 'Active', color: '#facc15' },
   planned: { label: 'Planned', color: '#99a2b2' },
   completed: { label: 'Completed', color: '#4cb782' },
};

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

/** Populated via the gateway API at runtime. */
export const initiatives: Initiative[] = [];

export function getInitiativeById(id: string): Initiative | undefined {
   return initiatives.find((i) => i.id === id);
}

export function getInitiativeProjects(initiative: Initiative): Project[] {
   return projects.filter((p) => initiative.projectIds.includes(p.id));
}

export function countCompletedProjects(initiative: Initiative): number {
   return projects.filter((p) => initiative.projectIds.includes(p.id) && p.percentComplete === 100)
      .length;
}
