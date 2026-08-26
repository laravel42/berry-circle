import type { Goal } from '@/lib/goals';
import { create } from 'zustand';

interface GoalsState {
   goals: Goal[];
   error: string | null;
   /** True once the workspace list has been read, so an empty list means empty. */
   loaded: boolean;
   hydrateGoals: (goals: Goal[], error?: string | null) => void;
   /** Merges a fuller read (one with progress) over the list row. */
   upsertGoal: (goal: Goal) => void;
   removeGoal: (goalId: string) => void;
   getGoalById: (goalId: string) => Goal | undefined;
}

function sortGoals(goals: Goal[]): Goal[] {
   return goals.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
   goals: [],
   error: null,
   loaded: false,
   hydrateGoals: (goals, error = null) =>
      set((state) => {
         // The list omits progress; keep what a single read already told us.
         const merged = goals.map((goal) => {
            const known = state.goals.find((candidate) => candidate.id === goal.id);
            return goal.progress || !known?.progress ? goal : { ...goal, progress: known.progress };
         });
         return { goals: sortGoals(merged), error, loaded: true };
      }),
   upsertGoal: (goal) =>
      set((state) => {
         const known = state.goals.find((candidate) => candidate.id === goal.id);
         const next = state.goals.filter((candidate) => candidate.id !== goal.id);
         next.push(
            goal.progress || !known?.progress ? goal : { ...goal, progress: known.progress }
         );
         return { goals: sortGoals(next), error: null };
      }),
   removeGoal: (goalId) =>
      set((state) => ({ goals: state.goals.filter((goal) => goal.id !== goalId) })),
   getGoalById: (goalId) => get().goals.find((goal) => goal.id === goalId),
}));
