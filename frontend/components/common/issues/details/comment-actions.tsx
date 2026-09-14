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
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { BerryApiError } from '@/lib/api';
import { deleteComment, updateComment, type ApiComment } from '@/lib/comments';
import { createChild } from '@/lib/issue-tracking';
import { useSessionStore } from '@/store/session-store';
import { MoreHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * What a reader can do with one comment.
 *
 * Edit and delete follow the server's rule — the author, or a workspace
 * admin — and the menu now says so on both sides: an admin sees the actions
 * on someone else's comment because they really do have them, rather than the
 * menu hiding them and the server quietly allowing them.
 *
 * Deleting warns when replies go with it. A thread root takes its thread with
 * it, and "delete" that silently removes four other people's messages is the
 * kind of surprise that only happens once per team.
 */
export function CommentActions({
   comment,
   issueRef,
   replyCount,
   onChanged,
   onDeleted,
   onReply,
}: {
   comment: ApiComment;
   issueRef: string;
   /** Replies that would go with it; only a root has any. */
   replyCount: number;
   onChanged: (comment: ApiComment) => void;
   onDeleted: (commentId: string) => void;
   onReply?: () => void;
}) {
   const t = useTranslations('issueDetail.activity');
   const user = useSessionStore((state) => state.user);
   const [editing, setEditing] = useState(false);
   const [confirming, setConfirming] = useState(false);
   const [draft, setDraft] = useState(comment.body);
   const [busy, setBusy] = useState(false);

   const mine = comment.author.type === 'user' && comment.author.id === user?.id;
   // A workspace admin moderates: the server allows it, so the menu offers it.
   const moderator = user?.role === 'Admin';
   const mayChange = mine || moderator;

   const fail = (cause: unknown, fallback: string) =>
      toast.error(
         cause instanceof BerryApiError && cause.status === 409
            ? 'This comment changed since you opened it. Reload and try again.'
            : cause instanceof BerryApiError && cause.status === 403
              ? 'You cannot change this comment.'
              : fallback
      );

   const save = () => {
      setBusy(true);
      void updateComment(comment.id, draft, comment.revision)
         .then((updated) => {
            onChanged(updated);
            setEditing(false);
         })
         .catch((cause: unknown) => fail(cause, t('saveFailed')))
         .finally(() => setBusy(false));
   };

   const remove = () => {
      setBusy(true);
      void deleteComment(comment.id)
         .then(() => {
            onDeleted(comment.id);
            setConfirming(false);
         })
         .catch((cause: unknown) => fail(cause, t('deleteFailed')))
         .finally(() => setBusy(false));
   };

   const copy = () => {
      void navigator.clipboard
         .writeText(comment.body)
         .then(() => toast.success(t('copied')))
         .catch(() => undefined);
   };

   const split = () =>
      void createChild(issueRef, { fromCommentId: comment.id })
         .then((child) => toast.success(t('subIssueCreated', { identifier: child.identifier })))
         .catch(() => toast.error(t('saveFailed')));

   return (
      <>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-6"
                  aria-label={t('title')}
               >
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               {onReply ? (
                  <DropdownMenuItem onClick={onReply}>{t('reply')}</DropdownMenuItem>
               ) : null}
               <DropdownMenuItem onClick={copy}>{t('copy')}</DropdownMenuItem>
               <DropdownMenuItem onClick={split}>{t('createSubIssue')}</DropdownMenuItem>
               {mayChange ? (
                  <>
                     <DropdownMenuSeparator />
                     <DropdownMenuItem
                        onClick={() => {
                           setDraft(comment.body);
                           setEditing(true);
                        }}
                     >
                        {t('edit')}
                     </DropdownMenuItem>
                     <DropdownMenuItem onClick={() => setConfirming(true)}>
                        {t('delete')}
                     </DropdownMenuItem>
                  </>
               ) : null}
            </DropdownMenuContent>
         </DropdownMenu>

         <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>{t('editTitle')}</DialogTitle>
               </DialogHeader>
               <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={6}
               />
               <DialogFooter>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                     {t('cancel')}
                  </Button>
                  <Button onClick={save} disabled={busy || !draft.trim() || draft === comment.body}>
                     {t('save')}
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>

         <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                     {replyCount > 0
                        ? `${t('deleteBody')} ${t('deleteWithReplies', { count: replyCount })}`
                        : t('deleteBody')}
                  </AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel disabled={busy}>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     disabled={busy}
                     onClick={(event) => {
                        event.preventDefault();
                        remove();
                     }}
                  >
                     {t('confirmDelete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </>
   );
}
