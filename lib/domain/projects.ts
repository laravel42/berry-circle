import { Status } from './status';
import { LucideIcon } from 'lucide-react';
import { RemixiconComponentType } from '@remixicon/react';
import { User } from './users';
import { LabelInterface } from './labels';
import { Priority } from './priorities';

export interface Project {
   id: string;
   name: string;
   status: Status;
   icon: LucideIcon | RemixiconComponentType;
   percentComplete: number;
   startDate: string;
   /** Planned completion date (Linear "Target date"). */
   targetDate?: string;
   lead: User;
   priority: Priority;
   health: Health;
   /** Owning team. */
   teamId: string;
   labels: LabelInterface[];
   initiative?: string;
   /** Days since the last health update (undefined = no update yet). */
   healthUpdatedAgoDays?: number;
}

export interface Health {
   id: 'no-update' | 'off-track' | 'on-track' | 'at-risk';
   name: string;
   color: string;
   description: string;
}

/** Populated via the gateway API at runtime. */
export const health: Health[] = [];

/** Populated via the gateway API at runtime. */
export const projects: Project[] = [];

/** Resolve by id from the current project list (populated at runtime). */
export function getProjectById(id: string): Project | undefined {
   return projects.find((p) => p.id === id);
}

/** Filter projects by owning team (populated at runtime). */
export function getProjectsByTeam(teamId: string): Project[] {
   return projects.filter((p) => p.teamId === teamId);
}
