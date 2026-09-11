import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * How a person has arranged the task page, remembered between visits.
 *
 * Three different memories, all of the same kind: a choice about the view that
 * the reader made once and should not have to make again. They are kept
 * together because they share a lifetime — a task page — and persisted because
 * re-collapsing the same sub-task list on every visit is the kind of small
 * friction nobody reports and everybody feels.
 *
 * Scroll position is deliberately *not* persisted to disk. It is a within-
 * session convenience ("I came back from the sub-task I clicked"), and a
 * two-day-old scroll offset restored against an edited description lands
 * nowhere meaningful.
 */

interface IssueViewState {
   /** The properties sidebar, shared across tasks: it is one preference. */
   sidebarOpen: boolean;
   /** Sub-task lists a person folded away, by issue identifier. */
   collapsedSubIssues: Record<string, boolean>;
   /** Per-session scroll offsets, by issue identifier. */
   scroll: Record<string, number>;

   toggleSidebar: () => void;
   setSubIssuesCollapsed: (issueRef: string, collapsed: boolean) => void;
   rememberScroll: (issueRef: string, offset: number) => void;
}

export const useIssueViewStore = create<IssueViewState>()(
   persist(
      (set) => ({
         sidebarOpen: true,
         collapsedSubIssues: {},
         scroll: {},

         toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
         setSubIssuesCollapsed: (issueRef, collapsed) =>
            set((state) => ({
               collapsedSubIssues: { ...state.collapsedSubIssues, [issueRef]: collapsed },
            })),
         rememberScroll: (issueRef, offset) =>
            set((state) => ({ scroll: { ...state.scroll, [issueRef]: offset } })),
      }),
      {
         name: 'issue-view-v1',
         partialize: (state) => ({
            sidebarOpen: state.sidebarOpen,
            collapsedSubIssues: state.collapsedSubIssues,
         }),
      }
   )
);
