'use client';

import { payloadEntityId, subscribeWorkspaceEvents } from '@/lib/events';
import { isPlanCompiling, isPlanGenerating, type PlanRecord } from '@/lib/plans';
import { useEventStreamStore } from '@/store/event-stream-store';
import { usePlanStore, type PlanBusyStage } from '@/store/plan-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** How often to re-read a live plan while the workspace stream is down. */
const FALLBACK_POLL_INTERVAL_MS = 3000;

interface PlanView {
   record: PlanRecord | undefined;
   error: string | null;
   busy: PlanBusyStage | null;
}

/**
 * A plan, kept current while the planner works on it.
 *
 * The workspace stream says when a plan moved — `plan.updated` on every
 * stage, `plan.generated` or `plan.blocked` at the end, `plan.*` after Start
 * — and the page re-reads the record on each. Only while the stream is down
 * does it fall back to a 3 s poll, so a person never watches a stale stage
 * because a laptop slept through the reconnect.
 */
export function usePlan(planId: string): PlanView {
   const status = useSessionStore((state) => state.status);
   const connected = useEventStreamStore((state) => state.connected);
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

   useEffect(() => {
      if (!live || status !== 'ready') return;
      const controller = new AbortController();
      if (connected) {
         // The stream may have reconnected after a stage ended; one read
         // catches up, and the events carry it from here.
         void loadPlan(planId, { signal: controller.signal });
         return () => controller.abort();
      }
      const timer = setInterval(() => {
         void loadPlan(planId, { signal: controller.signal });
      }, FALLBACK_POLL_INTERVAL_MS);
      return () => {
         clearInterval(timer);
         controller.abort();
      };
   }, [live, connected, status, planId, loadPlan]);

   return { record, error, busy };
}
