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

/** Workspace teams. Empty until the gateway provides them. */
export const teams: Team[] = [];

export function getTeamById(id: string): Team | undefined {
   return teams.find((team) => team.id === id);
}

/**
 * Team resolution for URL-scoped pages (`/{org}/team/{teamId}/…`).
 *
 * Returns the matching team, or a minimal placeholder derived from the URL
 * id so pages can render their empty state instead of crashing while no
 * teams exist. Replaced by gateway data once teams are wired.
 */
export function getTeamForUrl(id: string | undefined): Team {
   if (id) {
      const found = teams.find((team) => team.id === id);
      if (found) return found;
   }

   return {
      id: id || 'team',
      name: id || 'Team',
      icon: '📋',
      joined: true,
      color: '#5e6ad2',
      members: [],
      projects: [],
   };
}
