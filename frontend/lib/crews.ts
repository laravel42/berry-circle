import type { Project } from '@/data/projects';
import type { Team } from '@/data/teams';
import type { User } from '@/data/users';
import { type BoardSummary, listBoards } from './boards';
import { loadBoardIssues } from './issues';

const CREW_ICONS = ['🛠️', '🎨', '🌐', '🧠', '📈', '🔌', '☀️', '📋', '✅', '🔒', '💡', '📱'];

function iconForCrew(name: string, index: number): string {
   let hash = 0;
   for (let i = 0; i < name.length; i += 1) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
   }
   return CREW_ICONS[(hash + index) % CREW_ICONS.length] ?? '📋';
}

function colorForCrew(name: string): string {
   let hash = 0;
   for (let i = 0; i < name.length; i += 1) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
   }
   const hue = hash % 360;
   return `hsl(${hue} 45% 55%)`;
}

export function boardToCrew(
   board: BoardSummary,
   members: User[],
   projects: Project[],
   issueCount: number,
   index: number
): Team {
   return {
      id: board.id,
      identifier: board.slug.toUpperCase(),
      name: board.name,
      icon: iconForCrew(board.name, index),
      joined: true,
      color: colorForCrew(board.name),
      members,
      projects,
      issueCount,
      createdAt: board.createdAt,
      updatedAt: board.updatedAt,
   };
}

export async function loadWorkspaceCrews(
   members: User[],
   projects: Project[]
): Promise<Team[]> {
   const boards = await listBoards();
   if (boards.length === 0) return [];

   const issueCounts = await Promise.all(
      boards.map(async (board) => {
         try {
            const issues = await loadBoardIssues(board.id);
            return issues.length;
         } catch {
            return 0;
         }
      })
   );

   return boards.map((board, index) =>
      boardToCrew(board, members, projects, issueCounts[index] ?? 0, index)
   );
}
