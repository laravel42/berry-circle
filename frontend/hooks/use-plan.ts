'use client';

import { payloadEntityId, subscribeWorkspaceEvents } from '@/lib/events';
import { isPlanCompiling, isPlanGenerating, type PlanRecord } from '@/lib/plans';
import { usePlanStore, type PlanBusyStage } from '@/store/plan-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** How often to re-read a plan that is generating, compiling or routing. */
const POLL_INTERVAL_MS = 3000;

interface PlanView {
   record: PlanRecord | undefined;
   error: string | null;
   busy: PlanBusyStage | null;
}

/**
 * A plan, kept current while the planner works on it.
 *
 * Re-read on a timer while the planner is working on it, and on any `plan.*`
 * the workspace stream happens to carry. The timer is the load-bearing half:
 * the server publishes no plan events today, so the stream alone would leave
 * the page on whatever version it first read.
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

   useEffect(() => {
      if (status !== 'ready' || !planId) return;
      const controller = new AbortController();
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!event.type.startsWith('plan.')) return;
         const id = event.planId ?? payloadEntityId(event, 'plan');
         if (id !== planId) return;
         void loadPlan(planId, { signal: controller.signal });
      });
      return () => {
         unsubscribe();
         controller.abort();
      };
   }, [status, planId, loadPlan]);

   const live = record ? isPlanGenerating(record) || isPlanCompiling(record) : false;

   // Polled whenever the plan is working, connected or not.
   //
   // The subscription above is kept because it costs nothing and catches a
   // plan moved by something other than its own pipeline. It is not enough on
   // its own: nothing in the server writes a `plan.*` event to the outbox —
   // the names exist in the relay's list of known topics and are never
   // published — so a page that waited for one would sit on the version it
   // first read while the plan generated, compiled and routed behind it.
   //
   // That is exactly what a person watching would call "it stalled", and it is
   // the reason answering a blocked plan looked like it had done nothing.
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
