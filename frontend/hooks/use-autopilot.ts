'use client';

import {
   describeAutopilotFailure,
   getAutopilot,
   isAutopilotEvent,
   listAutopilotRuns,
   listWebhookDeliveries,
   type AutopilotDetail,
   type AutopilotRun,
   type WebhookDelivery,
} from '@/lib/autopilots';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useCallback, useEffect, useState } from 'react';

interface AutopilotView {
   autopilot: AutopilotDetail | undefined;
   runs: AutopilotRun[];
   deliveries: WebhookDelivery[];
   error: string | null;
   loading: boolean;
   reload: () => void;
}

/**
 * One autopilot with its history. Re-read quietly when a frame about this
 * autopilot arrives — a run recorded, a delivery received — because the
 * history is what someone opened the page to watch.
 */
export function useAutopilot(autopilotId: string): AutopilotView {
   const status = useSessionStore((state) => state.status);
   const [autopilot, setAutopilot] = useState<AutopilotDetail | undefined>(undefined);
   const [runs, setRuns] = useState<AutopilotRun[]>([]);
   const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [loading, setLoading] = useState(true);
   const [nonce, setNonce] = useState(0);
   const reload = useCallback(() => setNonce((value) => value + 1), []);

   useEffect(() => {
      if (status !== 'ready' || !autopilotId) return;
      const controller = new AbortController();
      void Promise.all([
         getAutopilot(autopilotId, controller.signal),
         listAutopilotRuns(autopilotId),
         listWebhookDeliveries(autopilotId),
      ])
         .then(([detail, runRows, deliveryRows]) => {
            if (controller.signal.aborted) return;
            setAutopilot(detail);
            setRuns(runRows);
            setDeliveries(deliveryRows);
            setError(null);
         })
         .catch((failure: unknown) => {
            if (!controller.signal.aborted) setError(describeAutopilotFailure(failure));
         })
         .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
         });
      return () => controller.abort();
   }, [status, autopilotId, nonce]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!isAutopilotEvent(event, autopilotId)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(reload, 400);
      });
      return () => {
         unsubscribe();
         if (timer) clearTimeout(timer);
      };
   }, [autopilotId, reload]);

   return { autopilot, runs, deliveries, error, loading: loading && !autopilot, reload };
}
