'use client';

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
import { deleteComment, setCommentResolved, updateComment, type ApiComment } from '@/lib/comments';
import { createChild } from '@/lib/issue-tracking';
import { useSessionStore } from '@/store/session-store';
import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * What a reader can do with one comment. Edit and delete follow the server's
 * rule (author, or an owner/admin); the menu offers them to the author and lets
 * the server refuse anyone else with a message.
 */
export function CommentActions({
   comment,
   issueRef,
   onChanged,
   onDeleted,
}: {
   comment: ApiComment;
   issueRef: string;
   onChanged: (comment: ApiComment) => void;
   onDeleted: (commentId: string) => void;
}) {
   const userId = useSessionStore((state) => state.user?.id ?? '');
   const [editing, setEditing] = useState(false);
   const [draft, setDraft] = useState(comment.body);
   const isRoot = !comment.parentId;
   const mine = comment.author.type === 'user' && comment.author.id === userId;

   const fail = (cause: unknown, fallback: string) =>
      toast.error(
         cause instanceof BerryApiError && cause.status === 409
            ? 'This comment changed since you opened it. Reload and try again.'
            : cause instanceof BerryApiError && cause.status === 403
              ? 'You cannot change this comment.'
              : fallback
      );

   const save = () =>
      void updateComment(comment.id, draft, comment.revision)
         .then((updated) => {
            onChanged(updated);
            setEditing(false);
         })
         .catch((cause: unknown) => fail(cause, 'The comment could not be saved.'));

   const remove = () => {
      if (!window.confirm('Delete this comment?')) return;
      void deleteComment(comment.id)
         .then(() => onDeleted(comment.id))
         .catch((cause: unknown) => fail(cause, 'The comment could not be deleted.'));
   };

   const resolve = () =>
      void setCommentResolved(comment.id, !comment.resolvedAt)
         .then(onChanged)
         .catch((cause: unknown) => fail(cause, 'The thread could not be updated.'));

   const split = () =>
      void createChild(issueRef, { fromCommentId: comment.id })
         .then((child) => toast.success(`${child.identifier} created from this comment`))
         .catch(() => toast.error('The sub-task could not be created.'));

   return (
      <>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button variant="ghost" size="icon" className="ml-auto size-6" aria-label="Comment actions">
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
               {isRoot ? (
                  <DropdownMenuItem onClick={resolve}>{comment.resolvedAt ? 'Reopen thread' : 'Resolve thread'}</DropdownMenuItem>
               ) : null}
               <DropdownMenuItem onClick={split}>Create sub-task from comment</DropdownMenuItem>
               {mine ? (
                  <>
                     <DropdownMenuSeparator />
                     <DropdownMenuItem
                        onClick={() => {
                           setDraft(comment.body);
                           setEditing(true);
                        }}
                     >
                        Edit
                     </DropdownMenuItem>
                     <DropdownMenuItem onClick={remove}>Delete</DropdownMenuItem>
                  </>
               ) : null}
            </DropdownMenuContent>
         </DropdownMenu>
         <Dialog open={editing} onOpenChange={setEditing}>
            <DialogContent>
               <DialogHeader>
                  <DialogTitle>Edit comment</DialogTitle>
               </DialogHeader>
               <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={6} />
               <DialogFooter>
                  <Button variant="ghost" onClick={() => setEditing(false)}>
                     Cancel
                  </Button>
                  <Button onClick={save} disabled={!draft.trim() || draft === comment.body}>
                     Save
                  </Button>
               </DialogFooter>
            </DialogContent>
         </Dialog>
      </>
   );
}
