'use client';

import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { setIssueProject } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { useProjectsStore } from '@/store/projects-store';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/**
 * Everything an issue menu can do, independent of how it is presented.
 *
 * The same actions are offered from a right-click on a row and from the
 * overflow menu beside the title, and Radix's context and dropdown menus are
 * different component families — so the behaviour lives here and each surface
 * only decides which primitives to render it with. Duplicating the handlers
 * would mean two versions of "set the project" that drift apart, which is how
 * one of them ends up not persisting.
 */
export function useIssueActions(issueId?: string) {
   const {
      updateIssueStatus,
      updateIssuePriority,
      updateIssueAssignee,
      addIssueLabel,
      removeIssueLabel,
      updateIssueProject,
      updateIssue,
      getIssueById,
   } = useIssuesStore();

   const issue = issueId ? getIssueById(issueId) : undefined;
   const projects = useProjectsStore((state) => state.projects);
   const members = useMembersStore((state) => state.members);
   const labels = useLabelsStore((state) => state.labels);

   const [isSubscribed, setIsSubscribed] = useState(false);
   const [isFavorite, setIsFavorite] = useState(false);

   const setStatus = useCallback(
      (statusId: string) => {
         if (!issueId) return;
         const next = status.find((candidate) => candidate.id === statusId);
         if (!next) return;
         updateIssueStatus(issueId, next);
         toast.success(`Status updated to ${next.name}`);
      },
      [issueId, updateIssueStatus]
   );

   const setPriority = useCallback(
      (priorityId: string) => {
         if (!issueId) return;
         const next = priorities.find((candidate) => candidate.id === priorityId);
         if (!next) return;
         updateIssuePriority(issueId, next);
         toast.success(`Priority updated to ${next.name}`);
      },
      [issueId, updateIssuePriority]
   );

   const setAssignee = useCallback(
      (userId: string | null) => {
         if (!issueId) return;
         const next = userId ? members.find((user) => user.id === userId) || null : null;
         updateIssueAssignee(issueId, next);
         toast.success(next ? `Assigned to ${next.name}` : 'Unassigned');
      },
      [issueId, members, updateIssueAssignee]
   );

   const toggleLabel = useCallback(
      (labelId: string) => {
         if (!issueId || !issue) return;
         const label = labels.find((candidate) => candidate.id === labelId);
         if (!label) return;
         if (issue.labels.some((candidate) => candidate.id === labelId)) {
            removeIssueLabel(issueId, labelId);
            toast.success(`Removed label: ${label.name}`);
         } else {
            addIssueLabel(issueId, label);
            toast.success(`Added label: ${label.name}`);
         }
      },
      [issueId, issue, labels, addIssueLabel, removeIssueLabel]
   );

   const setProject = useCallback(
      (projectId: string | null) => {
         if (!issueId || !issue) return;
         const next = projectId
            ? projects.find((candidate) => candidate.id === projectId)
            : undefined;
         const previous = issue.project;
         updateIssueProject(issueId, next);
         toast.success(next ? `Project set to ${next.name}` : 'Project removed');

         // Persisted, not just shown. The link lives in its own table rather
         // than a column on the issue, and until this call existed the change
         // was local only and disappeared on the next load.
         void setIssueProject(issue.identifier, projectId).catch(() => {
            updateIssueProject(issueId, previous);
            toast.error('That project could not be saved.');
         });
      },
      [issueId, issue, projects, updateIssueProject]
   );

   const setDueDateInAWeek = useCallback(() => {
      if (!issueId) return;
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7);
      updateIssue(issueId, { dueDate: dueDate.toISOString() });
      toast.success('Due date set to 7 days from now');
   }, [issueId, updateIssue]);

   const copyTitle = useCallback(() => {
      if (!issue) return;
      void navigator.clipboard.writeText(issue.title);
      toast.success('Copied to clipboard');
   }, [issue]);

   const copyLink = useCallback(() => {
      if (!issue) return;
      void navigator.clipboard.writeText(`${window.location.origin}/issue/${issue.identifier}`);
      toast.success('Link copied to clipboard');
   }, [issue]);

   const toggleSubscribed = useCallback(() => {
      setIsSubscribed((previous) => {
         toast.success(previous ? 'Unsubscribed from task' : 'Subscribed to task');
         return !previous;
      });
   }, []);

   const toggleFavorite = useCallback(() => {
      setIsFavorite((previous) => {
         toast.success(previous ? 'Removed from favorites' : 'Added to favorites');
         return !previous;
      });
   }, []);

   // Placeholders kept from the original menu. They acknowledge the click and
   // nothing else; naming them here rather than inlining a toast at each call
   // site is what makes it obvious they are not implemented yet.
   const notYetImplemented = useCallback(
      (message: string) => () => {
         toast.success(message);
      },
      []
   );

   return {
      issue,
      projects,
      members,
      labels,
      isSubscribed,
      isFavorite,
      setStatus,
      setPriority,
      setAssignee,
      toggleLabel,
      setProject,
      setDueDateInAWeek,
      copyTitle,
      copyLink,
      toggleSubscribed,
      toggleFavorite,
      addLink: notYetImplemented('Link added'),
      addDocument: notYetImplemented('Document added'),
      makeCopy: notYetImplemented('Task copied'),
      createRelated: notYetImplemented('Related task created'),
      markAs: (kind: string) => notYetImplemented(`Marked as ${kind}`)(),
      move: notYetImplemented('Task moved'),
      remindMe: notYetImplemented('Reminder set'),
      showDescriptionHistory: notYetImplemented('Description history is not available yet'),
   };
}
