'use client';

import { currentUser } from '@/data/users';
import { BerryApiError } from '@/lib/api';
import { loadWorkspaceAgents } from '@/lib/agents';
import { loadWorkspaceLabels } from '@/lib/labels';
import { loadWorkspaceInbox, loadInboxUnreadCount } from '@/lib/inbox';
import { loadBoardIssues } from '@/lib/issues';
import { loadWorkspaceMembers } from '@/lib/members';
import { loadWorkspaceProjects } from '@/lib/projects';
import { loadBoardRuns } from '@/lib/runs';
import { loadWorkspaceViews } from '@/lib/views';
import { useAgentsStore } from '@/store/agents-store';
import { useIssuesStore } from '@/store/issues-store';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { useNotificationsStore } from '@/store/notifications-store';
import { useProjectsStore } from '@/store/projects-store';
import { useRunsStore } from '@/store/runs-store';
import { useSessionStore } from '@/store/session-store';
import { useViewsStore } from '@/store/views-store';
import { useEffect } from 'react';

/**
 * Seeds workspace data from the Go API once a session is ready.
 */
export function useHydrateWorkspaceData(): void {
   const status = useSessionStore((state) => state.status);
   const boardId = useSessionStore((state) => state.boardId);
   const workspaceId = useSessionStore((state) => state.workspace?.id);
   const user = useSessionStore((state) => state.user);
   const hydrateIssues = useIssuesStore((state) => state.hydrateIssues);
   const hydrateProjects = useProjectsStore((state) => state.hydrateProjects);
   const hydrateNotifications = useNotificationsStore((state) => state.hydrateNotifications);
   const setServerUnreadCount = useNotificationsStore((state) => state.setServerUnreadCount);
   const hydrateAgents = useAgentsStore((state) => state.hydrateAgents);
   const hydrateRuns = useRunsStore((state) => state.hydrateRuns);
   const hydrateMembers = useMembersStore((state) => state.hydrateMembers);
   const hydrateLabels = useLabelsStore((state) => state.hydrateLabels);
   const hydrateViews = useViewsStore((state) => state.hydrateViews);

   useEffect(() => {
      if (status !== 'ready' || !boardId) return;
      let cancelled = false;
      void loadBoardIssues(boardId).then((issues) => {
         if (!cancelled) hydrateIssues(issues);
      });
      void loadBoardRuns(boardId, { first: 200 })
         .then((runs) => {
            if (!cancelled) hydrateRuns(runs, null);
         })
         .catch((error: unknown) => {
            if (!cancelled) {
               hydrateRuns(
                  [],
                  error instanceof BerryApiError ? error.message : 'Runs could not be loaded.'
               );
            }
         });
      return () => {
         cancelled = true;
      };
   }, [status, boardId, hydrateIssues, hydrateRuns]);

   useEffect(() => {
      if (status !== 'ready' || !workspaceId) return;
      let cancelled = false;
      const lead = user ?? currentUser;
      void loadWorkspaceProjects(workspaceId, lead).then((projects) => {
         if (!cancelled) hydrateProjects(projects);
      });
      void loadWorkspaceInbox(workspaceId, lead).then((items) => {
         if (!cancelled) hydrateNotifications(items);
      });
      void loadInboxUnreadCount(workspaceId).then((count) => {
         if (!cancelled) setServerUnreadCount(count);
      });
      void loadWorkspaceAgents()
         .then((agents) => {
            if (!cancelled) hydrateAgents(agents, null);
         })
         .catch((error: unknown) => {
            if (!cancelled) {
               hydrateAgents(
                  [],
                  error instanceof BerryApiError ? error.message : 'Agent runtime is unavailable.'
               );
            }
         });
      void loadWorkspaceMembers(workspaceId).then((members) => {
         if (!cancelled) hydrateMembers(members);
      });
      void loadWorkspaceLabels(workspaceId).then((labels) => {
         if (!cancelled) hydrateLabels(labels);
      });
      void loadWorkspaceViews(workspaceId, lead).then((views) => {
         if (!cancelled) hydrateViews(views);
      });
      return () => {
         cancelled = true;
      };
   }, [
      status,
      workspaceId,
      user,
      hydrateProjects,
      hydrateNotifications,
      setServerUnreadCount,
      hydrateAgents,
      hydrateMembers,
      hydrateLabels,
      hydrateViews,
   ]);
}
