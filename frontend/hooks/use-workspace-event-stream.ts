'use client';

import { currentUser } from '@/data/users';
import { loadWorkspaceApprovals } from '@/lib/approvals';
import { publishWorkspaceEvent, streamWorkspaceEvents, type EventEnvelope } from '@/lib/events';
import { loadWorkspaceGoals } from '@/lib/goals';
import { loadInboxUnreadCount, loadWorkspaceInbox } from '@/lib/inbox';
import { useApprovalsStore } from '@/store/approvals-store';
import { useEventStreamStore } from '@/store/event-stream-store';
import { useGoalsStore } from '@/store/goals-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** How long to wait for a burst to settle before refetching. */
const REFRESH_DEBOUNCE_MS = 400;

/** Reconnect delays: first retry quickly, then back off to the cap. */
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30_000;

type Family = 'goals' | 'approvals' | 'inbox';

/** Which stores a frame makes stale. Events are invalidation signals only. */
function familiesFor(event: EventEnvelope): Family[] {
   const type = event.type;
   if (type.startsWith('goal.')) return ['goals'];
   if (type.startsWith('approval.')) return ['approvals', 'goals', 'inbox'];
   if (type.startsWith('plan.')) return ['inbox', 'goals'];
   if (type.startsWith('issue.')) return ['goals'];
   return [];
}

/**
 * Keeps goals, approvals and the inbox live.
 *
 * One connection per page over `GET /api/v1/events?workspaceId=`; every
 * frame is fanned out to in-page subscribers (a plan page refetches its
 * record on `plan.updated`) and, debounced, refreshes the stores the frame
 * touched. The last event id is remembered so a reconnect resumes with
 * `after` and misses nothing the server retained.
 */
export function useWorkspaceEventStream(): void {
   const status = useSessionStore((state) => state.status);
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const user = useSessionStore((state) => state.user);
   const hydrateGoals = useGoalsStore((state) => state.hydrateGoals);
   const hydrateApprovals = useApprovalsStore((state) => state.hydrateApprovals);
   const hydrateNotifications = useNotificationsStore((state) => state.hydrateNotifications);
   const setServerUnreadCount = useNotificationsStore((state) => state.setServerUnreadCount);
   const setConnected = useEventStreamStore((state) => state.setConnected);
   const setLastEventId = useEventStreamStore((state) => state.setLastEventId);

   useEffect(() => {
      if (status !== 'ready' || !workspaceId) return;

      const controller = new AbortController();
      let cancelled = false;
      let reconnectDelay = RECONNECT_MIN_MS;
      let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Set<Family>();
      let refreshTimer: ReturnType<typeof setTimeout> | undefined;
      const actor = user ?? currentUser;

      const refresh = () => {
         const families = Array.from(pending);
         pending.clear();
         if (families.includes('goals')) {
            void loadWorkspaceGoals(workspaceId).then((goals) => {
               if (!cancelled) hydrateGoals(goals);
            });
         }
         if (families.includes('approvals')) {
            void loadWorkspaceApprovals(workspaceId).then((approvals) => {
               if (!cancelled) hydrateApprovals(approvals);
            });
         }
         if (families.includes('inbox')) {
            void loadWorkspaceInbox(workspaceId, actor).then((items) => {
               if (!cancelled) hydrateNotifications(items);
            });
            void loadInboxUnreadCount(workspaceId).then((count) => {
               if (!cancelled) setServerUnreadCount(count);
            });
         }
      };

      const scheduleRefresh = (families: Family[]) => {
         for (const family of families) pending.add(family);
         if (pending.size === 0) return;
         if (refreshTimer) clearTimeout(refreshTimer);
         refreshTimer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
      };

      const consume = async () => {
         try {
            const after = useEventStreamStore.getState().lastEventId ?? undefined;
            const events = streamWorkspaceEvents(workspaceId, {
               after,
               signal: controller.signal,
            });
            for await (const event of events) {
               if (cancelled) return;
               if (!useEventStreamStore.getState().connected) setConnected(true);
               reconnectDelay = RECONNECT_MIN_MS;
               setLastEventId(event.id);
               publishWorkspaceEvent(event);
               scheduleRefresh(familiesFor(event));
            }
         } catch {
            // A dropped stream is expected — a sleeping laptop, a restarted
            // API, an expired cursor. It is retried rather than surfaced.
         }
         if (cancelled) return;
         setConnected(false);
         // Whatever happened while the stream was down is not in the stores.
         scheduleRefresh(['goals', 'approvals', 'inbox']);
         reconnectTimer = setTimeout(() => {
            if (!cancelled) void consume();
         }, reconnectDelay);
         reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      };

      void consume();

      return () => {
         cancelled = true;
         controller.abort();
         setConnected(false);
         if (refreshTimer) clearTimeout(refreshTimer);
         if (reconnectTimer) clearTimeout(reconnectTimer);
      };
   }, [
      status,
      workspaceId,
      user,
      hydrateGoals,
      hydrateApprovals,
      hydrateNotifications,
      setServerUnreadCount,
      setConnected,
      setLastEventId,
   ]);
}
