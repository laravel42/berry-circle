'use client';

import { isPlanCompiling, isPlanGenerating, type PlanRecord } from '@/lib/plans';
import { usePlanStore, type PlanBusyStage } from '@/store/plan-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** How often to re-read a plan whose generation or compile is in flight. */
const POLL_INTERVAL_MS = 3000;

interface PlanView {
   record: PlanRecord | undefined;
   error: string | null;
   busy: PlanBusyStage | null;
}

/**
 * A plan, kept current while the planner works on it.
 *
 * Generation runs in the background for a minute or more and the record's
 * `generation.stage` is the only visible progress, so the page re-reads it
 * every few seconds until the status settles. Polling rather than the
 * workspace event stream: the stream helper does not exist yet (P4 adds
 * it), and a stage lasts long enough that a 3 s read is never behind by
 * anything a person would notice.
 */
export function usePlan(planId: string): PlanView {
   const status = useSessionStore((state) => state.status);
   const record = usePlanStore((state) => state.records[planId]);
   const error = usePlanStore((state) => state.errors[planId] ?? null);
   const busy = usePlanStore((state) => state.busy[planId] ?? null);
   const loadPlan = usePlanStore((state) => state.loadPlan);

   useEffect(() => {
      if (status !== 'ready' || !planId) return;
      const controller = new AbortController();
      void loadPlan(planId, { signal: controller.signal });
      return () => controller.abort();
   }, [status, planId, loadPlan]);

   const live = record ? isPlanGenerating(record) || isPlanCompiling(record) : false;

   useEffect(() => {
      if (!live || status !== 'ready') return;
      const controller = new AbortController();
      const timer = setInterval(() => {
         void loadPlan(planId, { signal: controller.signal });
      }, POLL_INTERVAL_MS);
      return () => {
         clearInterval(timer);
         controller.abort();
      };
   }, [live, status, planId, loadPlan]);

   return { record, error, busy };
}
