import { isTerminalRunStatus, listIssueRuns, type RunRecord } from '@/lib/runs';
import { useEffect } from 'react';
import { create } from 'zustand';

/**
 * The runs of one task, shared by everything on its page.
 *
 * The header's live agent chip and the sidebar's execution log are the same
 * fact rendered twice — what the agents have done to this task — and they are
 * rendered by two components that are siblings in the layout, not parent and
 * child. Without somewhere to share, each would fetch the list itself and the
 * two could disagree about whether a run had been cancelled.
 */

interface IssueRunsState {
   byIssue: Record<string, RunRecord[]>;
   loading: Record<string, boolean>;
   load: (issueId: string) => void;
   upsert: (issueId: string, run: RunRecord) => void;
}

const newestFirst = (runs: RunRecord[]): RunRecord[] =>
   [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

export const useIssueRunsStore = create<IssueRunsState>((set, get) => ({
   byIssue: {},
   loading: {},

   load: (issueId) => {
      if (!issueId || get().loading[issueId]) return;
      set((state) => ({ loading: { ...state.loading, [issueId]: true } }));
      void listIssueRuns(issueId)
         .then((runs) =>
            set((state) => ({ byIssue: { ...state.byIssue, [issueId]: newestFirst(runs) } }))
         )
         .catch(() => undefined)
         .finally(() => set((state) => ({ loading: { ...state.loading, [issueId]: false } })));
   },

   upsert: (issueId, run) =>
      set((state) => {
         const current = state.byIssue[issueId] ?? [];
         return {
            byIssue: {
               ...state.byIssue,
               [issueId]: newestFirst([run, ...current.filter((entry) => entry.id !== run.id)]),
            },
         };
      }),
}));

export interface IssueRuns {
   runs: RunRecord[];
   /** The queued or running one, which is what a live chip renders. */
   activeRun: RunRecord | null;
   upsert: (run: RunRecord) => void;
}

/**
 * One shared empty array for every task with no runs yet.
 *
 * The selector below feeds `useSyncExternalStore`, which compares snapshots by
 * identity. A fresh `[]` per call is a new snapshot every render, and the
 * subscriber re-renders forever.
 */
const NO_RUNS: RunRecord[] = [];

export function useIssueRuns(issueId: string | undefined): IssueRuns {
   const runs = useIssueRunsStore((state) => (issueId ? (state.byIssue[issueId] ?? NO_RUNS) : NO_RUNS));
   const load = useIssueRunsStore((state) => state.load);
   const upsertRun = useIssueRunsStore((state) => state.upsert);

   useEffect(() => {
      if (issueId) load(issueId);
   }, [issueId, load]);

   return {
      runs,
      activeRun: runs.find((run) => !isTerminalRunStatus(run.status)) ?? null,
      upsert: (run: RunRecord) => {
         if (issueId) upsertRun(issueId, run);
      },
   };
}
