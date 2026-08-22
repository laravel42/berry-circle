import { LabelInterface } from './labels';
import { Priority } from './priorities';
import { Project } from './projects';
import { Status, StatusCategory } from './status';
import { User } from './users';

export interface Issue {
   id: string;
   identifier: string;
   title: string;
   description: string;
   status: Status;
   assignee: User | null;
   priority: Priority;
   labels: LabelInterface[];
   createdAt: string;
   /** Cycle the issue belongs to. Empty string = no cycle (backlog stock). */
   cycleId: string;
   project?: Project;
   subissues?: string[];
   rank: string;
   dueDate?: string;
}

/** Populated via the gateway API at runtime. */
export const issues: Issue[] = [];

/** Populated via the gateway API at runtime. */
export const ranks: string[] = [];

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

export function groupIssuesByStatus(issues: Issue[]): Record<string, Issue[]> {
   return issues.reduce<Record<string, Issue[]>>((acc, issue) => {
      const statusId = issue.status.id;

      if (!acc[statusId]) {
         acc[statusId] = [];
      }

      acc[statusId].push(issue);

      return acc;
   }, {});
}

export function sortIssuesByPriority(issues: Issue[]): Issue[] {
   const priorityOrder: Record<string, number> = {
      'urgent': 0,
      'high': 1,
      'medium': 2,
      'low': 3,
      'no-priority': 4,
   };

   return issues
      .slice()
      .sort(
         (a, b) =>
            priorityOrder[a.priority.id as keyof typeof priorityOrder] -
            priorityOrder[b.priority.id as keyof typeof priorityOrder]
      );
}

export function filterIssuesByCycle(allIssues: Issue[], cycleId: string): Issue[] {
   return allIssues.filter((issue) => issue.cycleId === cycleId);
}

export function filterIssuesByCategories(
   allIssues: Issue[],
   categories: StatusCategory[]
): Issue[] {
   return allIssues.filter((issue) => categories.includes(issue.status.category));
}

/**
 * Deterministic pseudo-creator for an issue.
 * Used by the member profile "Created" tab.
 */
export function issueCreatorIndex(issue: Issue, memberCount: number): number {
   let hash = 0;
   for (let i = 0; i < issue.identifier.length; i++) {
      hash = (hash * 31 + issue.identifier.charCodeAt(i)) >>> 0;
   }
   return hash % memberCount;
}
