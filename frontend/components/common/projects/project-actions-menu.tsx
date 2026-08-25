'use client';

import {
   DeleteProjectDialog,
   useProjectDeletion,
} from '@/components/common/projects/delete-project';
import { useProjectActions } from '@/components/common/projects/use-project-actions';
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
import { health as healthOptions, type Project } from '@/data/projects';
import {
   BellOff,
   CalendarPlus,
   Clipboard,
   Clock,
   Copy as CopyIcon,
   FileText,
   HeartPulse,
   History,
   Link as LinkIcon,
   MoreHorizontal,
   PlusSquare,
   Star,
   Trash2,
} from 'lucide-react';

/**
 * The overflow menu beside a project's name.
 *
 * The mirror of the issue one, and narrower than it looks for the same reason:
 * status, priority, lead and health all sit in the project's own panel, so the
 * menu carries what has nowhere else to live. Health is the exception — it is
 * the field people change without opening anything, so it earns a submenu.
 */
export function ProjectActionsMenu({
   project,
   onDeleted,
}: {
   project: Project;
   onDeleted?: () => void;
}) {
   const actions = useProjectActions(project.id);
   const deletion = useProjectDeletion(onDeleted);

   return (
      <>
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground"
                  aria-label="Project actions"
               >
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-64">
               <DropdownMenuItem onClick={actions.setTargetDateInAMonth}>
                  <CalendarPlus className="size-4" /> Target date
                  <DropdownMenuShortcut>⇧D</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                     <HeartPulse className="size-4" /> Health
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                     {healthOptions.map((option) => (
                        <DropdownMenuItem
                           key={option.id}
                           onClick={() => actions.setHealth(option.id)}
                        >
                           {option.name}
                        </DropdownMenuItem>
                     ))}
                  </DropdownMenuSubContent>
               </DropdownMenuSub>
               <DropdownMenuItem onClick={actions.addLink}>
                  <LinkIcon className="size-4" /> Add link...
                  <DropdownMenuShortcut>⌘L</DropdownMenuShortcut>
               </DropdownMenuItem>
               <DropdownMenuItem onClick={actions.addDocument}>
                  <FileText className="size-4" /> Add document...
               </DropdownMenuItem>

               <DropdownMenuSeparator />

               <DropdownMenuItem onClick={actions.createIssue}>
                  <PlusSquare className="size-4" /> Create issue
               </DropdownMenuItem>

               <DropdownMenuSeparator />

               <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                     <Clipboard className="size-4" /> Copy
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                     <DropdownMenuItem onClick={actions.copyName}>Copy name</DropdownMenuItem>
                     <DropdownMenuItem onClick={actions.copyLink}>Copy link</DropdownMenuItem>
                  </DropdownMenuSubContent>
               </DropdownMenuSub>
               <DropdownMenuItem onClick={actions.makeCopy}>
                  <CopyIcon className="size-4" /> Duplicate project
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

               <DropdownMenuItem onClick={actions.showHistory}>
                  <History className="size-4" /> Show project history
               </DropdownMenuItem>
               <DropdownMenuItem
                  variant="destructive"
                  onSelect={(event) => {
                     // Selecting closes the menu, which would unmount the
                     // dialog with it, so the dialog is opened instead.
                     event.preventDefault();
                     deletion.request(project);
                  }}
               >
                  <Trash2 className="size-4" /> Delete
                  <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>

         <DeleteProjectDialog deletion={deletion} />
      </>
   );
}
