'use client';

import { describeGoalFailure, getGoal, type Goal } from '@/lib/goals';
import { payloadEntityId, subscribeWorkspaceEvents } from '@/lib/events';
import { useGoalsStore } from '@/store/goals-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect, useState } from 'react';

interface GoalView {
   goal: Goal | undefined;
   error: string | null;
   loading: boolean;
}

/**
 * One goal with its progress. The list omits progress, so the page always
 * reads the record itself, and reads it again when a task, approval or the
 * goal changes — the counts are what a person came here for.
 */
export function useGoal(goalId: string): GoalView {
   const status = useSessionStore((state) => state.status);
   const goal = useGoalsStore((state) => state.goals.find((candidate) => candidate.id === goalId));
   const upsertGoal = useGoalsStore((state) => state.upsertGoal);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(false);

   useEffect(() => {
      if (status !== 'ready' || !goalId) return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = (quiet: boolean) => {
         if (!quiet) setLoading(true);
         void getGoal(goalId, controller.signal)
            .then((fetched) => {
               upsertGoal(fetched);
               setError(null);
            })
            .catch((failure: unknown) => {
               if (controller.signal.aborted) return;
               if (!quiet) setError(describeGoalFailure(failure));
            })
            .finally(() => {
               if (!controller.signal.aborted && !quiet) setLoading(false);
            });
      };
      read(false);
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         const type = event.type;
         const relevant =
            (type.startsWith('goal.') &&
               (event.goalId ?? payloadEntityId(event, 'goal')) === goalId) ||
            type.startsWith('issue.') ||
            type.startsWith('approval.') ||
            type.startsWith('workflow.') ||
            type.startsWith('plan.');
         if (!relevant) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(() => read(true), 400);
      });
      return () => {
         unsubscribe();
         controller.abort();
         if (timer) clearTimeout(timer);
      };
   }, [status, goalId, upsertGoal]);

   return { goal, error, loading: loading && !goal };
}
