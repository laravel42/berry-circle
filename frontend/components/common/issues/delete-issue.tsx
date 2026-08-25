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
import type { Issue } from '@/data/issues';
import { deleteBoardIssue } from '@/lib/issues';
import { useIssuesStore } from '@/store/issues-store';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

export interface IssueDeletion {
   target: Issue | undefined;
   deleting: boolean;
   error: string | null;
   /** Open the confirmation for an issue. */
   request: (issue: Issue) => void;
   /** Close the confirmation without deleting. */
   dismiss: () => void;
   confirm: () => Promise<void>;
}

/**
 * Deleting an issue, shared by every surface that offers it.
 *
 * Extracted rather than repeated: the rules that make a destructive action
 * safe — confirm first, keep the dialog open while the request is in flight,
 * remove the card only once the server agrees — are easy to get subtly
 * different in a second copy, and a delete that behaves differently depending
 * on where it was clicked is worse than one that is missing.
 */
export function useIssueDeletion(onDeleted?: () => void): IssueDeletion {
   const removeFromStore = useIssuesStore((state) => state.deleteIssue);
   const [target, setTarget] = useState<Issue | undefined>();
   const [deleting, setDeleting] = useState(false);
   const [error, setError] = useState<string | null>(null);

   const request = useCallback((issue: Issue) => {
      setTarget(issue);
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
         await deleteBoardIssue(target.identifier);
         // Removed locally only after the server agreed. Dropping the card
         // first would show the issue as gone until a refresh brought it back.
         removeFromStore(target.id);
         toast.success(`${target.identifier} deleted`);
         setTarget(undefined);
         onDeleted?.();
      } catch {
         setError('This task could not be deleted. It may already be gone.');
      } finally {
         setDeleting(false);
      }
   }, [target, removeFromStore, onDeleted]);

   return { target, deleting, error, request, dismiss, confirm };
}

/** The confirmation shown by every delete entry point. */
export function DeleteIssueDialog({ deletion }: { deletion: IssueDeletion }) {
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
                  Delete {deletion.target?.identifier ?? 'this task'}?
               </AlertDialogTitle>
               <AlertDialogDescription>
                  It will be removed from the board. Its comments, run history and any files
                  agents produced are kept, and the identifier is not reused.
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
