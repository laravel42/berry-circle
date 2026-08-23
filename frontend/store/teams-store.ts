import type { Team } from '@/data/teams';
import { createBoard, slugFromBoardName, type BoardSummary } from '@/lib/boards';
import { boardToCrew } from '@/lib/crews';
import type { Project } from '@/data/projects';
import type { User } from '@/data/users';
import { create } from 'zustand';

interface TeamsState {
   teams: Team[];
   hydrateTeams: (teams: Team[]) => void;
   addTeam: (team: Team) => void;
   addCrewFromBoard: (board: BoardSummary, members: User[], projects: Project[]) => void;
   getTeamById: (id: string) => Team | undefined;
}

export const useTeamsStore = create<TeamsState>((set, get) => ({
   teams: [],

   hydrateTeams: (teams) => set({ teams }),

   addTeam: (team) =>
      set((state) => ({
         teams: [team, ...state.teams.filter((entry) => entry.id !== team.id)],
      })),

   addCrewFromBoard: (board, members, projects) =>
      set((state) => {
         const crew = boardToCrew(board, members, projects, 0, state.teams.length);
         return {
            teams: [crew, ...state.teams.filter((entry) => entry.id !== crew.id)],
         };
      }),

   getTeamById: (id) => get().teams.find((team) => team.id === id),
}));

export function getTeamById(id: string): Team | undefined {
   return useTeamsStore.getState().getTeamById(id);
}

/** Placeholder crew for URL-scoped pages while data is loading. */
export function getTeamForUrl(id: string | undefined): Team {
   if (id) {
      const found = getTeamById(id);
      if (found) return found;
   }

   return {
      id: id || 'crew',
      identifier: id?.slice(0, 8).toUpperCase() || 'CREW',
      name: id || 'Crew',
      icon: '📋',
      joined: true,
      color: '#5e6ad2',
      members: [],
      projects: [],
   };
}

export async function createWorkspaceCrew(input: {
   name: string;
   description?: string;
   lead: User;
   members: User[];
   projects: Project[];
}): Promise<Team> {
   const slug = slugFromBoardName(input.name);
   const board = await createBoard({
      name: input.name.trim(),
      slug,
      description: input.description,
   });
   const roster = [input.lead, ...input.members.filter((member) => member.id !== input.lead.id)];
   return {
      ...boardToCrew(board, roster, input.projects, 0, 0),
      lead: input.lead,
   };
}
