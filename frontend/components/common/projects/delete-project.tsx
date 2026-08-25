'use client';

import {
   AlertDialog,
   AlertDialogAction,
   AlertDialogCancel,
   AlertDialogContent,
   AlertDialogDescription,
   AlertDialogFooter,
   AlertDialogHeader,
   AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { Project } from '@/data/projects';
import { deleteWorkspaceProject } from '@/lib/projects';
import { useIssuesStore } from '@/store/issues-store';
import { useProjectsStore } from '@/store/projects-store';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

export interface ProjectDeletion {
   target: Project | undefined;
   deleting: boolean;
   error: string | null;
   /** How many issues currently sit in the project being deleted. */
   linkedIssues: number;
   request: (project: Project) => void;
   dismiss: () => void;
   confirm: () => Promise<void>;
}

/**
 * Deleting a project, shared by every surface that offers it.
 *
 * The same shape as issue deletion, and for the same reason: the rules that
 * make a destructive action safe are easy to get subtly different in a second
 * copy, and an action that behaves differently depending on where it was
 * clicked is worse than one that is missing.
 */
export function useProjectDeletion(onDeleted?: () => void): ProjectDeletion {
   const removeFromStore = useProjectsStore((state) => state.deleteProject);
   const issues = useIssuesStore((state) => state.issues);
   const [target, setTarget] = useState<Project | undefined>();
   const [deleting, setDeleting] = useState(false);
   const [error, setError] = useState<string | null>(null);

   // Counted rather than guessed. Deleting a project does not delete its
   // issues, and saying how many will be left unfiled is the difference
   // between an informed confirmation and a blind one.
   const linkedIssues = useMemo(
      () => (target ? issues.filter((issue) => issue.project?.id === target.id).length : 0),
      [issues, target]
   );

   const request = useCallback((project: Project) => {
      setTarget(project);
      setError(null);
   }, []);

   const dismiss = useCallback(() => {
      setTarget(undefined);
      setError(null);
   }, []);

   const confirm = useCallback(async () => {
      if (!target) return;
      setDeleting(true);
      setError(null);
      try {
         await deleteWorkspaceProject(target.id);
         removeFromStore(target.id);
         toast.success(`${target.name} deleted`);
         setTarget(undefined);
         onDeleted?.();
      } catch {
         setError('This project could not be deleted. It may already be gone.');
      } finally {
         setDeleting(false);
      }
   }, [target, removeFromStore, onDeleted]);

   return { target, deleting, error, linkedIssues, request, dismiss, confirm };
}

/** The confirmation shown by every project delete entry point. */
export function DeleteProjectDialog({ deletion }: { deletion: ProjectDeletion }) {
   return (
      <AlertDialog
         open={deletion.target !== undefined}
         onOpenChange={(open) => {
            if (!open) deletion.dismiss();
         }}
      >
         <AlertDialogContent>
            <AlertDialogHeader>
               <AlertDialogTitle>
                  Delete {deletion.target?.name ?? 'this project'}?
               </AlertDialogTitle>
               <AlertDialogDescription>
                  {deletion.linkedIssues > 0
                     ? `${deletion.linkedIssues} ${
                          deletion.linkedIssues === 1 ? 'task stays' : 'tasks stay'
                       } on the board without a project. Nothing else is removed.`
                     : 'It will be removed from the projects list. Nothing else is removed.'}
               </AlertDialogDescription>
            </AlertDialogHeader>
            {deletion.error ? <p className="text-destructive">{deletion.error}</p> : null}
            <AlertDialogFooter>
               <AlertDialogCancel disabled={deletion.deleting}>Cancel</AlertDialogCancel>
               <AlertDialogAction
                  disabled={deletion.deleting}
                  onClick={(event) => {
                     // Kept open until the request settles, so a failure is
                     // visible instead of the dialog closing on an error.
                     event.preventDefault();
                     void deletion.confirm();
                  }}
               >
                  {deletion.deleting ? 'Deleting…' : 'Delete'}
               </AlertDialogAction>
            </AlertDialogFooter>
         </AlertDialogContent>
      </AlertDialog>
   );
}
