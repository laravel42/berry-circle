'use client';

import { currentUser } from '@/data/users';
import { getWorkspaceProject } from '@/lib/projects';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { useEffect } from 'react';

/** Resolves a project from the store, fetching it if this tab has not listed yet. */
export function useProject(projectId: string) {
   const project = useProjectsStore((state) =>
      state.projects.find((entry) => entry.id === projectId)
   );
   const addProject = useProjectsStore((state) => state.addProject);
   const user = useSessionStore((state) => state.user);
   const status = useSessionStore((state) => state.status);

   useEffect(() => {
      if (status !== 'ready' || project) return;
      let cancelled = false;
      void getWorkspaceProject(projectId, user ?? currentUser).then((fetched) => {
         if (!cancelled && fetched) addProject(fetched);
      });
      return () => {
         cancelled = true;
      };
   }, [status, project, projectId, user, addProject]);

   return project;
}
