import { groupIssuesByStatus, Issue } from '@/data/issues';
import { LabelInterface } from '@/data/labels';
import { Priority } from '@/data/priorities';
import { Project } from '@/data/projects';
import { Status } from '@/data/status';
import { User } from '@/data/users';
import {
   assigneeToApi,
   describePatchFailure,
   type IssuePatchBody,
   patchBoardIssue,
   patchFailureApprovalId,
   rankFromSortOrder,
   sortOrderBetween,
} from '@/lib/issues';
import { apiPriorityFromUi, apiStatusFromUi } from '@/lib/catalog';
import { WORKSPACE_SLUG } from '@/lib/config';
import Link from 'next/link';
import { createElement } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';

/** Where the first load of the task list got to. */
export type IssuesLoadState = 'loading' | 'ready' | 'error';

interface IssuesState {
   // Data
   issues: Issue[];
   issuesByStatus: Record<string, Issue[]>;
   /** The list's own load state, so a view can show a skeleton or a retry. */
   loadState: IssuesLoadState;
   loadError: string | null;
   /** Bumped by `retryLoad`; the hydrating hook watches it and fetches again. */
   retryToken: number;
   setLoadState: (state: IssuesLoadState, error?: string | null) => void;
   retryLoad: () => void;

   //
   getAllIssues: () => Issue[];

   // Actions
   hydrateIssues: (issues: Issue[]) => void;
   addIssue: (issue: Issue) => void;
   updateIssue: (id: string, updatedIssue: Partial<Issue>) => void;
   deleteIssue: (id: string) => void;

   // Filters
   filterByStatus: (statusId: string) => Issue[];
   filterByPriority: (priorityId: string) => Issue[];
   filterByAssignee: (userId: string | null) => Issue[];
   filterByLabel: (labelId: string) => Issue[];
   filterByProject: (projectId: string) => Issue[];
   searchIssues: (query: string) => Issue[];

   // Status management
   updateIssueStatus: (issueId: string, newStatus: Status) => void;

   /** Reorder within a column and optionally move across status columns on the board. */
   moveIssue: (
      issueId: string,
      target: { targetStatus?: Status; insertBeforeId?: string | null }
   ) => void;

   // Priority management
   updateIssuePriority: (issueId: string, newPriority: Priority) => void;

   // Assignee management
   updateIssueAssignee: (issueId: string, newAssignee: User | null) => void;

   updateIssueDescription: (issueId: string, description: string) => void;

   // Labels management
   addIssueLabel: (issueId: string, label: LabelInterface) => void;
   removeIssueLabel: (issueId: string, labelId: string) => void;

   // Project management
   updateIssueProject: (issueId: string, newProject: Project | undefined) => void;

   // Utility functions
   getIssueById: (id: string) => Issue | undefined;
}

/**
 * Optimistic write: apply locally, send the patch, and on refusal put the
 * previous values back and say why. The revert matters as much as the toast —
 * a card left showing a status the server rejected is a lie until refresh.
 */
function commitPatch(
   get: () => IssuesState,
   issueId: string,
   optimistic: Partial<Issue>,
   patch: IssuePatchBody
): void {
   const current = get().getIssueById(issueId);
   if (!current) return;
   const previous: Partial<Issue> = {};
   for (const key of Object.keys(optimistic) as (keyof Issue)[]) {
      Object.assign(previous, { [key]: current[key] });
   }
   get().updateIssue(issueId, optimistic);
   void patchBoardIssue(issueId, patch).catch((error: unknown) => {
      get().updateIssue(issueId, previous);
      // A gated task names the approval that holds it, so the toast can
      // take the person straight to the decision instead of a dead end.
      const approvalId = patchFailureApprovalId(error);
      toast.error(
         describePatchFailure(error),
         approvalId
            ? {
                 description: createElement(
                    Link,
                    {
                       href: `/${WORKSPACE_SLUG}/approvals?approval=${encodeURIComponent(approvalId)}`,
                       className: 'underline underline-offset-2',
                    },
                    'View the approval'
                 ),
              }
            : undefined
      );
   });
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
   // Initial state
   issues: [],
   issuesByStatus: {},
   loadState: 'loading',
   loadError: null,
   retryToken: 0,

   setLoadState: (loadState, loadError = null) => set({ loadState, loadError }),
   retryLoad: () =>
      set((state) => ({
         loadState: 'loading',
         loadError: null,
         retryToken: state.retryToken + 1,
      })),

   //
   getAllIssues: () => get().issues,

   // Actions
   hydrateIssues: (incoming: Issue[]) => {
      set({
         issues: incoming,
         issuesByStatus: groupIssuesByStatus(incoming),
      });
   },

   addIssue: (issue: Issue) => {
      set((state) => {
         const newIssues = [...state.issues, issue];
         return {
            issues: newIssues,
            issuesByStatus: groupIssuesByStatus(newIssues),
         };
      });
   },

   updateIssue: (id: string, updatedIssue: Partial<Issue>) => {
      set((state) => {
         const newIssues = state.issues.map((issue) =>
            issue.id === id ? { ...issue, ...updatedIssue } : issue
         );

         return {
            issues: newIssues,
            issuesByStatus: groupIssuesByStatus(newIssues),
         };
      });
   },

   deleteIssue: (id: string) => {
      set((state) => {
         const newIssues = state.issues.filter((issue) => issue.id !== id);
         return {
            issues: newIssues,
            issuesByStatus: groupIssuesByStatus(newIssues),
         };
      });
   },

   // Filters
   filterByStatus: (statusId: string) => {
      return get().issues.filter((issue) => issue.status.id === statusId);
   },

   filterByPriority: (priorityId: string) => {
      return get().issues.filter((issue) => issue.priority.id === priorityId);
   },

   filterByAssignee: (userId: string | null) => {
      if (userId === null) {
         return get().issues.filter((issue) => issue.assignee === null);
      }
      return get().issues.filter((issue) => issue.assignee?.id === userId);
   },

   filterByLabel: (labelId: string) => {
      return get().issues.filter((issue) => issue.labels.some((label) => label.id === labelId));
   },

   filterByProject: (projectId: string) => {
      return get().issues.filter((issue) => issue.project?.id === projectId);
   },

   searchIssues: (query: string) => {
      const lowerCaseQuery = query.toLowerCase();
      return get().issues.filter(
         (issue) =>
            issue.title.toLowerCase().includes(lowerCaseQuery) ||
            issue.identifier.toLowerCase().includes(lowerCaseQuery)
      );
   },

   // Status management
   updateIssueStatus: (issueId: string, newStatus: Status) => {
      commitPatch(get, issueId, { status: newStatus }, { status: apiStatusFromUi(newStatus.id) });
   },

   moveIssue: (issueId, { targetStatus, insertBeforeId }) => {
      const issue = get().getIssueById(issueId);
      if (!issue) return;

      const status = targetStatus ?? issue.status;
      const columnIssues = get()
         .issues.filter((row) => row.status.id === status.id && row.id !== issueId)
         .sort((a, b) => a.sortOrder - b.sortOrder || a.rank.localeCompare(b.rank));

      let beforeSort: number | undefined;
      let afterSort: number | undefined;

      if (insertBeforeId === null || insertBeforeId === undefined) {
         const last = columnIssues.at(-1);
         beforeSort = last?.sortOrder;
         afterSort = undefined;
      } else {
         const insertIndex = columnIssues.findIndex((row) => row.id === insertBeforeId);
         if (insertIndex === -1) {
            const last = columnIssues.at(-1);
            beforeSort = last?.sortOrder;
            afterSort = undefined;
         } else {
            afterSort = columnIssues[insertIndex].sortOrder;
            beforeSort = insertIndex > 0 ? columnIssues[insertIndex - 1].sortOrder : undefined;
         }
      }

      const newSortOrder = sortOrderBetween(beforeSort, afterSort);
      const newRank = rankFromSortOrder(newSortOrder);
      const statusChanged = status.id !== issue.status.id;

      const patch: { sortOrder: number; status?: string } = { sortOrder: newSortOrder };
      if (statusChanged) {
         patch.status = apiStatusFromUi(status.id);
      }
      commitPatch(
         get,
         issueId,
         { rank: newRank, sortOrder: newSortOrder, ...(statusChanged ? { status } : {}) },
         patch
      );
   },

   // Priority management
   updateIssuePriority: (issueId: string, newPriority: Priority) => {
      commitPatch(
         get,
         issueId,
         { priority: newPriority },
         { priority: apiPriorityFromUi(newPriority.id) }
      );
   },

   // Assignee management
   updateIssueAssignee: (issueId: string, newAssignee: User | null) => {
      commitPatch(
         get,
         issueId,
         { assignee: newAssignee },
         { assignee: assigneeToApi(newAssignee) }
      );
   },

   updateIssueDescription: (issueId: string, description: string) => {
      commitPatch(get, issueId, { description }, { description: description || null });
   },

   // Labels management
   addIssueLabel: (issueId: string, label: LabelInterface) => {
      const issue = get().getIssueById(issueId);
      if (issue) {
         const updatedLabels = [...issue.labels, label];
         get().updateIssue(issueId, { labels: updatedLabels });
      }
   },

   removeIssueLabel: (issueId: string, labelId: string) => {
      const issue = get().getIssueById(issueId);
      if (issue) {
         const updatedLabels = issue.labels.filter((label) => label.id !== labelId);
         get().updateIssue(issueId, { labels: updatedLabels });
      }
   },

   // Project management
   updateIssueProject: (issueId: string, newProject: Project | undefined) => {
      get().updateIssue(issueId, { project: newProject });
   },

   // Utility functions
   getIssueById: (id: string) => {
      return get().issues.find((issue) => issue.id === id);
   },
}));
