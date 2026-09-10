'use client';

import {
   describeAutopilotFailure,
   isAutopilotEvent,
   listAutopilots,
   type Autopilot,
} from '@/lib/autopilots';
import { subscribeWorkspaceEvents } from '@/lib/events';
import { useSessionStore } from '@/store/session-store';
import { useCallback, useEffect, useState } from 'react';

interface AutopilotsView {
   autopilots: Autopilot[];
   error: string | null;
   loaded: boolean;
   reload: () => void;
}

/** The workspace's autopilots, re-read when any autopilot fact arrives on the stream. */
export function useAutopilots(): AutopilotsView {
   const status = useSessionStore((state) => state.status);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const [autopilots, setAutopilots] = useState<Autopilot[]>([]);
   const [error, setError] = useState<string | null>(null);
   const [loaded, setLoaded] = useState(false);
   const [nonce, setNonce] = useState(0);
   const reload = useCallback(() => setNonce((value) => value + 1), []);

   useEffect(() => {
      if (status !== 'ready' || !workspaceId) return;
      let cancelled = false;
      void listAutopilots(workspaceId)
         .then((nodes) => {
            if (cancelled) return;
            setAutopilots(nodes);
            setError(null);
         })
         .catch((failure: unknown) => {
            if (!cancelled) setError(describeAutopilotFailure(failure));
         })
         .finally(() => {
            if (!cancelled) setLoaded(true);
         });
      return () => {
         cancelled = true;
      };
   }, [status, workspaceId, nonce]);

   useEffect(() => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = subscribeWorkspaceEvents((event) => {
         if (!isAutopilotEvent(event)) return;
         if (timer) clearTimeout(timer);
         timer = setTimeout(reload, 400);
      });
      return () => {
         unsubscribe();
         if (timer) clearTimeout(timer);
      };
   }, [reload]);

   return { autopilots, error, loaded, reload };
}
