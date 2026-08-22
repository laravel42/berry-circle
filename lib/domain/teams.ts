import { Project } from './projects';
import { User } from './users';

export interface Team {
   id: string;
   name: string;
   icon: string;
   joined: boolean;
   color: string;
   members: User[];
   projects: Project[];
}

/** Populated via the gateway API at runtime. */
export const teams: Team[] = [];
