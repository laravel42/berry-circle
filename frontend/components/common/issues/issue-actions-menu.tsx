'use client';

import { DeleteIssueDialog, useIssueDeletion } from '@/components/common/issues/delete-issue';
import { useIssueActions } from '@/components/common/issues/use-issue-actions';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuShortcut,
   DropdownMenuSub,
   DropdownMenuSubContent,
   DropdownMenuSubTrigger,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Issue } from '@/data/issues';
import {
   BellOff,
   CalendarPlus,
   Clipboard,
   Clock,
   Copy as CopyIcon,
   FileText,
   Flag,
   History,
   Link as LinkIcon,
   MoreHorizontal,
   PlusSquare,
   Star,
   Trash2,
} from 'lucide-react';

/**
 * The overflow menu beside an issue's title.
 *
 * Deliberately narrower than the right-click menu on a row. Status, assignee,
 * priority, labels and project are all one click away in the properties panel
 * whenever this is on screen, so repeating them here would be a second way to
 * do something already visible. What is left is the work that has nowhere else
 * to live.
 */
export function IssueActionsMenu({
   issue,
   onDeleted,
}: {
   issue: Issue;
   onDeleted?: () => void;
}) {
   const actions = useIssueActions(issue.id);
   const deletion = useIssueDeletion(onDeleted);

   return (
      <>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  aria-label="Task actions"
               >
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-64">
               <DropdownMenuItem onClick={actions.setDueDateInAWeek}>
                  <CalendarPlus className="size-4" /> Due date
                  <DropdownMenuShortcut>⇧D</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuItem onClick={actions.addLink}>
                  <LinkIcon className="size-4" /> Add link...
                  <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuItem onClick={actions.addDocument}>
                  <FileText className="size-4" /> Add document...
               </DropdownMenuItem>

               <DropdownMenuSeparator />

               <DropdownMenuItem onClick={actions.createRelated}>
                  <PlusSquare className="size-4" /> Create related
               </DropdownMenuItem>
               <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                     <Flag className="size-4" /> Mark as
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                     <DropdownMenuItem onClick={() => actions.markAs('duplicate')}>
                        Duplicate
                     </DropdownMenuItem>
                     <DropdownMenuItem onClick={() => actions.markAs('blocked')}>
                        Blocked
                     </DropdownMenuItem>
                     <DropdownMenuItem onClick={() => actions.markAs('blocking')}>
                        Blocking
                     </DropdownMenuItem>
                  </DropdownMenuSubContent>
               </DropdownMenuSub>

               <DropdownMenuSeparator />

               <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                     <Clipboard className="size-4" /> Copy
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                     <DropdownMenuItem onClick={actions.copyTitle}>Copy title</DropdownMenuItem>
                     <DropdownMenuItem onClick={actions.copyLink}>Copy link</DropdownMenuItem>
                  </DropdownMenuSubContent>
               </DropdownMenuSub>
               <DropdownMenuItem onClick={actions.makeCopy}>
                  <CopyIcon className="size-4" /> Duplicate issue
               </DropdownMenuItem>

               <DropdownMenuSeparator />

               <DropdownMenuItem onClick={actions.toggleFavorite}>
                  <Star className="size-4" /> {actions.isFavorite ? 'Unfavorite' : 'Favorite'}
                  <DropdownMenuShortcut>⌥F</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuItem onClick={actions.remindMe}>
                  <Clock className="size-4" /> Remind me
                  <DropdownMenuShortcut>⇧H</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuItem onClick={actions.toggleSubscribed}>
                  <BellOff className="size-4" />{' '}
                  {actions.isSubscribed ? 'Unsubscribe' : 'Subscribe'}
                  <DropdownMenuShortcut>⇧S</DropdownMenuShortcut>
               </DropdownMenuItem>

               <DropdownMenuSeparator />

               <DropdownMenuItem onClick={actions.showDescriptionHistory}>
                  <History className="size-4" /> Show description history
               </DropdownMenuItem>
               <DropdownMenuItem
                  variant="destructive"
                  onSelect={(event) => {
                     // Selecting closes the menu, which would unmount the
                     // dialog with it, so the dialog is opened instead.
                     event.preventDefault();
                     deletion.request(issue);
                  }}
               >
                  <Trash2 className="size-4" /> Delete
                  <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>

         <DeleteIssueDialog deletion={deletion} />
      </>
   );
}
