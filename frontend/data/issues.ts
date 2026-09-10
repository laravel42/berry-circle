import { LexoRank } from '@/lib/utils';
import { LabelInterface } from './labels';
import { Priority } from './priorities';
import { Project } from './projects';
import { Status } from './status';
import { User } from './users';

/** A task this one waits on, or that waits on it; enough to draw a row without a second read. */
export interface IssueDependencyRef {
   id: string;
   identifier: string;
   title: string;
   /** API `IssueStatus` of the other task. */
   status: string;
}

/** The workflow run that created a task. */
export interface IssueOrigin {
   workflowId: string;
   workflowRunId: string;
   workflowStepRunId?: string | null;
}

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
   /** Board column order from API (`sortOrder`). */
   sortOrder: number;
   dueDate?: string;
   activeRunId?: string | null;
   /** The goal the task serves; null when it serves none. */
   goal?: { id: string; title: string } | null;
   /** Set when a workflow run created the task. */
   origin?: IssueOrigin | null;
   /** Tasks that must finish before this one starts. */
   dependsOn?: IssueDependencyRef[];
   /** Tasks waiting on this one. */
   blocks?: IssueDependencyRef[];
   /** The task this one is a sub-task of. */
   parentId?: string | null;
   /** Ordered barrier among siblings: stage N+1 waits for stage N. */
   stage?: number | null;
   /** A workspace status refining `status`. */
   statusId?: string | null;
   childProgress?: { total: number; done: number };
}

/**
 * Issue seeds from the Circle template lived here. They were removed when
 * the demo data layer was stripped — the board boots empty and fills up
 * from the gateway (`lib/issues.ts`) when the API URL and board id are set.
 */
const seeds: unknown[] = [];

/* -------------------------------------------------------------------------- */
/*                                   Ranks                                    */
/* -------------------------------------------------------------------------- */

// Generates issue ranks using the LexoRank algorithm. New issues created
// locally take the next rank; the sequence is sized ahead of use.
export const ranks: string[] = [];
const generateIssuesRanks = () => {
   const firstRank = new LexoRank('a3c');
   ranks.push(firstRank.toString());
   for (let i = 1; i < seeds.length + 20; i++) {
      const previousRank = LexoRank.from(ranks[i - 1]);
      ranks.push(previousRank.increment().toString());
   }
};
generateIssuesRanks();

/* -------------------------------------------------------------------------- */
/*                                   Issues                                   */
/* -------------------------------------------------------------------------- */

export const issues: Issue[] = [];

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

/**
 * Deterministic pseudo-creator for an issue (the data model has no author
 * field). Used by the member profile "Created" tab.
 */
export function issueCreatorIndex(issue: Issue, memberCount: number): number {
   if (memberCount <= 0) return 0;
   let hash = 0;
   for (let i = 0; i < issue.identifier.length; i++) {
      hash = (hash * 31 + issue.identifier.charCodeAt(i)) >>> 0;
   }
   return hash % memberCount;
}
