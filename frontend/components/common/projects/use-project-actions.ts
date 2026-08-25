'use client';

import { health as healthOptions } from '@/data/projects';
import { patchWorkspaceProject } from '@/lib/projects';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Everything a project menu can do, independent of how it is presented.
 *
 * The mirror of useIssueActions, and separate from it on purpose: the two
 * share a shape but nothing else. Merging them would mean a single hook whose
 * every action needed to know which kind of record it was operating on.
 */
export function useProjectActions(projectId?: string) {
   const { updateProjectTargetDate, updateProjectHealth, getProjectById } = useProjectsStore();
   const sessionUser = useSessionStore((state) => state.user);

   const project = projectId ? getProjectById(projectId) : undefined;

   const [isSubscribed, setIsSubscribed] = useState(false);
   const [isFavorite, setIsFavorite] = useState(false);

   const setTargetDateInAMonth = useCallback(() => {
      if (!projectId || !project) return;
      const target = new Date();
      target.setMonth(target.getMonth() + 1);
      const iso = target.toISOString();
      const previous = project.targetDate;
      updateProjectTargetDate(projectId, iso);
      toast.success('Target date set to a month from now');

      // Persisted, not just shown. The local update is rolled back if the
      // server refuses, so the list does not keep a date the project lost.
      void patchWorkspaceProject(projectId, { targetDate: iso }, project.lead).then((saved) => {
         if (!saved) {
            updateProjectTargetDate(projectId, previous);
            toast.error('That target date could not be saved.');
         }
      });
   }, [projectId, project, updateProjectTargetDate]);

   const setHealth = useCallback(
      (healthId: string) => {
         if (!projectId) return;
         const next = healthOptions.find((candidate) => candidate.id === healthId);
         if (!next) return;
         updateProjectHealth(projectId, next.id);
         toast.success(`Health set to ${next.name}`);
      },
      [projectId, updateProjectHealth]
   );

   const copyName = useCallback(() => {
      if (!project) return;
      void navigator.clipboard.writeText(project.name);
      toast.success('Copied to clipboard');
   }, [project]);

   const copyLink = useCallback(() => {
      if (!project) return;
      void navigator.clipboard.writeText(`${window.location.origin}/project/${project.id}`);
      toast.success('Link copied to clipboard');
   }, [project]);

   const toggleSubscribed = useCallback(() => {
      setIsSubscribed((previous) => {
         toast.success(previous ? 'Unsubscribed from project' : 'Subscribed to project');
         return !previous;
      });
   }, []);

   const toggleFavorite = useCallback(() => {
      setIsFavorite((previous) => {
         toast.success(previous ? 'Removed from favorites' : 'Added to favorites');
         return !previous;
      });
   }, []);

   // Placeholders, named rather than inlined so it stays obvious which parts of
   // the menu are not implemented yet.
   const notYetImplemented = useCallback(
      (message: string) => () => {
         toast.success(message);
      },
      []
   );

   return {
      project,
      sessionUser,
      isSubscribed,
      isFavorite,
      setTargetDateInAMonth,
      setHealth,
      copyName,
      copyLink,
      toggleSubscribed,
      toggleFavorite,
      addLink: notYetImplemented('Link added'),
      addDocument: notYetImplemented('Document added'),
      makeCopy: notYetImplemented('Project copied'),
      createIssue: notYetImplemented('Task created in this project'),
      remindMe: notYetImplemented('Reminder set'),
      showHistory: notYetImplemented('Project history is not available yet'),
   };
}
