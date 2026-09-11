'use client';

import { priorities } from '@/data/priorities';
import { status } from '@/data/status';
import { createChild, setParent } from '@/lib/issue-tracking';
import { describePatchFailure, patchBoardIssue, setIssueProject } from '@/lib/issues';
import { pinTarget, unpinTarget } from '@/lib/pins';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useIssuesStore } from '@/store/issues-store';
import { useLabelsStore } from '@/store/labels-store';
import { useMembersStore } from '@/store/members-store';
import { usePinsStore } from '@/store/pins-store';
import { useProjectsStore } from '@/store/projects-store';
import { useSessionStore } from '@/store/session-store';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

/** Today, tomorrow or next week at the start of the day. */
function dayFromNow(days: number): Date {
   const date = new Date();
   date.setHours(0, 0, 0, 0);
   date.setDate(date.getDate() + days);
   return date;
}

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
      addIssue,
      getIssueById,
   } = useIssuesStore();

   const issue = issueId ? getIssueById(issueId) : undefined;
   const projects = useProjectsStore((state) => state.projects);
   const members = useMembersStore((state) => state.members);
   const labels = useLabelsStore((state) => state.labels);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const { pins, add: addPin, remove: removePin } = usePinsStore();
   const { orgId } = useParams<{ orgId?: string }>();

   const [isSubscribed, setIsSubscribed] = useState(false);
   const [isFavorite, setIsFavorite] = useState(false);

   const pin = issue
      ? pins.find((entry) => entry.targetType === 'issue' && entry.targetId === issue.id)
      : undefined;
   const issueHref = issue ? `/${orgId ?? WORKSPACE_SLUG}/issue/${issue.identifier}` : '';

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

   /** Sets or clears the due date, optimistically and then on the server. */
   const setDueDate = useCallback(
      (date: Date | null) => {
         if (!issueId || !issue) return;
         const previous = issue.dueDate;
         const next = date ? date.toISOString() : undefined;
         updateIssue(issueId, { dueDate: next });
         void patchBoardIssue(issueId, { dueDate: next ?? null }).catch((cause: unknown) => {
            updateIssue(issueId, { dueDate: previous });
            toast.error(describePatchFailure(cause));
         });
      },
      [issueId, issue, updateIssue]
   );

   const setDueDateInAWeek = useCallback(() => setDueDate(dayFromNow(7)), [setDueDate]);

   const copyTitle = useCallback(() => {
      if (!issue) return;
      void navigator.clipboard.writeText(issue.title);
      toast.success('Copied to clipboard');
   }, [issue]);

   const copyLink = useCallback(() => {
      if (!issue) return;
      void navigator.clipboard.writeText(`${window.location.origin}${issueHref}`);
      toast.success('Link copied to clipboard');
   }, [issue, issueHref]);

   const openInNewTab = useCallback(() => {
      if (!issue) return;
      window.open(issueHref, '_blank', 'noopener,noreferrer');
   }, [issue, issueHref]);

   /** Pins the task in the rail, or takes it back out. */
   const togglePin = useCallback(() => {
      if (!issue || !workspaceId) return;
      const write = pin
         ? unpinTarget(workspaceId, pin.id).then(() => removePin(pin.id))
         : pinTarget(workspaceId, 'issue', issue.id).then(addPin);
      void write.catch(() => toast.error('The pin could not be changed.'));
   }, [issue, workspaceId, pin, addPin, removePin]);

   const createSubIssue = useCallback(
      (title = 'New sub-task') => {
         if (!issue) return;
         void createChild(issue.identifier, { title })
            .then((child) => {
               addIssue(child);
               toast.success(`${child.identifier} created`);
            })
            .catch(() => toast.error('That sub-task could not be created.'));
      },
      [issue, addIssue]
   );

   const setParentIssue = useCallback(
      (parentId: string | null) => {
         if (!issue) return;
         void setParent(issue.identifier, parentId, null)
            .then(() => {
               updateIssue(issue.id, { parentId });
               toast.success(parentId ? 'Parent set' : 'Parent removed');
            })
            .catch(() => toast.error('That parent could not be saved.'));
      },
      [issue, updateIssue]
   );

   /** Adopts a task that already exists as a sub-task of this one. */
   const addExistingSubIssue = useCallback(
      (childId: string) => {
         if (!issue) return;
         const child = getIssueById(childId);
         if (!child) return;
         void setParent(child.identifier, issue.id, null)
            .then(() => {
               updateIssue(child.id, { parentId: issue.id });
               toast.success(`${child.identifier} is now a sub-task`);
            })
            .catch(() => toast.error('That sub-task could not be linked.'));
      },
      [issue, getIssueById, updateIssue]
   );

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
      issueHref,
      projects,
      members,
      labels,
      isSubscribed,
      isFavorite,
      isPinned: pin !== undefined,
      setStatus,
      setPriority,
      setAssignee,
      toggleLabel,
      setProject,
      setDueDate,
      setDueDateToday: () => setDueDate(dayFromNow(0)),
      setDueDateTomorrow: () => setDueDate(dayFromNow(1)),
      setDueDateNextWeek: () => setDueDate(dayFromNow(7)),
      clearDueDate: () => setDueDate(null),
      setDueDateInAWeek,
      copyTitle,
      copyLink,
      openInNewTab,
      togglePin,
      createSubIssue,
      setParentIssue,
      removeParent: () => setParentIssue(null),
      addExistingSubIssue,
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
