import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** One task someone opened, as little of it as the palette needs to show it. */
export interface RecentIssue {
   id: string;
   identifier: string;
   title: string;
   /** ISO time of the last visit, so the list is genuinely most-recent-first. */
   visitedAt: string;
}

/** The palette shows twenty; keeping a few more costs nothing and survives edits. */
const LIMIT = 30;

interface RecentIssuesState {
   issues: RecentIssue[];
   /** Record a visit. Visiting something already in the list moves it to the top. */
   visit: (issue: Omit<RecentIssue, 'visitedAt'>) => void;
   /** Drop one, for a task that turns out not to exist any more. */
   forget: (id: string) => void;
   clear: () => void;
}

/**
 * The tasks this person opened recently, in this browser.
 *
 * Local on purpose. "Recently visited" is a fact about a person at a machine,
 * not about the workspace: it should not follow them onto a shared screen, and
 * the server has no reason to keep a log of what anyone looked at.
 */
export const useRecentIssuesStore = create<RecentIssuesState>()(
   persist(
      (set) => ({
         issues: [],
         visit: (issue) =>
            set((state) => ({
               issues: [
                  { ...issue, visitedAt: new Date().toISOString() },
                  ...state.issues.filter((entry) => entry.id !== issue.id),
               ].slice(0, LIMIT),
            })),
         forget: (id) => set((state) => ({ issues: state.issues.filter((e) => e.id !== id) })),
         clear: () => set({ issues: [] }),
      }),
      { name: 'berry.recent-issues', version: 1 }
   )
);
