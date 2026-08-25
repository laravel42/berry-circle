'use client';

import { loadBoardIssues } from '@/lib/issues';
import { loadBoardRuns, streamBoardEvents } from '@/lib/runs';
import { useIssuesStore } from '@/store/issues-store';
import { useRunsStore } from '@/store/runs-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** How long to wait for a burst to settle before refetching. */
const REFRESH_DEBOUNCE_MS = 400;

/** How long to wait before reconnecting a dropped stream. */
const RECONNECT_DELAY_MS = 3000;

/**
 * Keeps the board live while agents work on it.
 *
 * Agents move issues without anyone clicking anything, so without this the
 * board is only ever as fresh as the last page load — work would complete and
 * the card would sit unchanged until someone reloaded.
 *
 * A run emits a burst of events (output deltas, tool calls, then completion),
 * and refetching on each would mean dozens of requests for one turn. The burst
 * is allowed to settle first, so a run costs roughly one refresh.
 */
export function useBoardEventStream(): void {
   const status = useSessionStore((state) => state.status);
   const boardId = useSessionStore((state) => state.boardId);
   const hydrateIssues = useIssuesStore((state) => state.hydrateIssues);
   const hydrateRuns = useRunsStore((state) => state.hydrateRuns);

   useEffect(() => {
      if (status !== 'ready' || !boardId) return;

      const controller = new AbortController();
      let cancelled = false;
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

      const refresh = () => {
         void loadBoardIssues(boardId)
            .then((issues) => {
               if (!cancelled) hydrateIssues(issues);
            })
            .catch(() => undefined);
         void loadBoardRuns(boardId, { first: 200 })
            .then((runs) => {
               if (!cancelled) hydrateRuns(runs, null);
            })
            .catch(() => undefined);
      };

      const scheduleRefresh = () => {
         if (refreshTimer) clearTimeout(refreshTimer);
         refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
      };

      const consume = async () => {
         try {
            const events = streamBoardEvents(boardId, controller.signal);
            // The event's contents do not matter here: any activity on the
            // board means the store is behind, and the refetch is what
            // reconciles it. Reading the payload would mean maintaining a
            // second, partial copy of the server's projection logic.
            for await (const event of events) {
               void event;
               if (cancelled) return;
               scheduleRefresh();
            }
         } catch {
            // A dropped stream is expected — a sleeping laptop, a restarted
            // API. Swallowed so it can be retried rather than surfaced as an
            // error the person cannot act on.
         }
         if (cancelled) return;
         // The stream ending is itself a reason to refresh: whatever happened
         // while it was down is not in the store.
         scheduleRefresh();
         reconnectTimer = setTimeout(() => {
            if (!cancelled) void consume();
         }, RECONNECT_DELAY_MS);
      };

      void consume();

      return () => {
         cancelled = true;
         controller.abort();
         if (refreshTimer) clearTimeout(refreshTimer);
         if (reconnectTimer) clearTimeout(reconnectTimer);
      };
   }, [status, boardId, hydrateIssues, hydrateRuns]);
}
