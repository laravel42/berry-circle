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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
   DropdownMenu,
   DropdownMenuContent,
   DropdownMenuItem,
   DropdownMenuSeparator,
   DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { View } from '@/data/views';
import { PinToggle } from '@/components/common/issues/details/issue-pin-button';
import { deleteSavedView, loadWorkspaceViews } from '@/lib/views';
import { useSessionStore } from '@/store/session-store';
import { useViewsStore } from '@/store/views-store';
import { useViewsDisplayStore, ViewsOrdering } from '@/store/views-display-store';
import { ArrowDown, MoreHorizontal, Plus, SlidersHorizontal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SaveViewDialog } from './save-view-dialog';

const TABS = ['issues', 'projects'] as const;

const formatDate = (iso: string): string => {
   const [year, month, day] = iso.split('-').map(Number);
   const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
   ];
   return `${months[(month ?? 1) - 1]} ${day}, ${year}`;
};

function DisplayOptions() {
   const { ordering, displayProperties, setOrdering, toggleProperty } = useViewsDisplayStore();

   return (
      <Popover>
         <PopoverTrigger asChild>
            <Button size="xs" variant="ghost" aria-label="Display options">
               <SlidersHorizontal className="size-4" />
            </Button>
         </PopoverTrigger>
         <PopoverContent align="end" className="w-72 p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
               <span className="text-muted-foreground">Ordering</span>
               <Select
                  value={ordering}
                  onValueChange={(value) => setOrdering(value as ViewsOrdering)}
               >
                  <SelectTrigger className="w-32 h-7">
                     <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="name">Name</SelectItem>
                     <SelectItem value="created">Created</SelectItem>
                     <SelectItem value="updated">Updated</SelectItem>
                  </SelectContent>
               </Select>
            </div>
            <div className="flex flex-col gap-2">
               <span className="text-muted-foreground">Display properties</span>
               <div className="flex flex-wrap gap-1.5">
                  {(
                     [
                        ['created', 'Created'],
                        ['updated', 'Updated'],
                        ['owner', 'Owner'],
                     ] as const
                  ).map(([key, label]) => (
                     <button
                        key={key}
                        onClick={() => toggleProperty(key)}
                        className={cn(
                           'px-2 py-0.5 rounded-md border transition-colors',
                           displayProperties[key]
                              ? 'bg-accent border-transparent'
                              : 'text-muted-foreground hover:bg-accent/50'
                        )}
                     >
                        {label}
                     </button>
                  ))}
               </div>
            </div>
         </PopoverContent>
      </Popover>
   );
}

function ViewRow({
   view,
   orgId,
   onEdit,
   onDelete,
}: {
   view: View;
   orgId: string;
   onEdit: () => void;
   onDelete: () => void;
}) {
   const t = useTranslations('issueLists');
   const { displayProperties } = useViewsDisplayStore();

   return (
      <div className="flex items-center gap-1 pr-4 border-b border-border/50 hover:bg-sidebar/50 transition-colors">
         <Link
            href={`/${orgId}/view/${view.id}`}
            className="flex flex-1 min-w-0 items-center gap-3 px-6 py-2.5"
         >
            <span className="inline-flex size-6 items-center justify-center rounded bg-muted/50 shrink-0">
               {view.icon}
            </span>
            <span className="flex flex-col min-w-0 flex-1">
               <span className="font-medium truncate">{view.name}</span>
               <span className="text-muted-foreground truncate">{view.description}</span>
            </span>
            {displayProperties.created && (
               <span className="hidden sm:block text-muted-foreground w-24 shrink-0">
                  {formatDate(view.createdAt)}
               </span>
            )}
            {displayProperties.updated && (
               <span className="hidden sm:block text-muted-foreground w-24 shrink-0">
                  {formatDate(view.updatedAt)}
               </span>
            )}
            {displayProperties.owner && (
               <span className="flex items-center gap-1.5 w-32 shrink-0 justify-end">
                  <Avatar className="size-5">
                     <AvatarImage src={view.owner.avatarUrl} alt={view.owner.name} />
                     <AvatarFallback>{view.owner.name[0]}</AvatarFallback>
                  </Avatar>
                  <span className="text-muted-foreground truncate max-w-24">{view.owner.name}</span>
               </span>
            )}
         </Link>
         <PinToggle targetType="view" targetId={view.id} />
         <DropdownMenu>
            <DropdownMenuTrigger asChild>
               <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  aria-label={`${view.name} menu`}
               >
                  <MoreHorizontal className="size-4" />
               </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
               <DropdownMenuItem onClick={onEdit}>{t('views.edit')}</DropdownMenuItem>
               <DropdownMenuSeparator />
               <DropdownMenuItem
                  variant="destructive"
                  onSelect={(event) => {
                     event.preventDefault();
                     onDelete();
                  }}
               >
                  {t('views.delete')}
               </DropdownMenuItem>
            </DropdownMenuContent>
         </DropdownMenu>
      </div>
   );
}

/** "Views" page: the workspace's saved issue / project views. */
export default function Views() {
   const t = useTranslations('issueLists');
   const { orgId } = useParams<{ orgId: string }>();
   const [tab, setTab] = useQueryState('tab', parseAsStringLiteral(TABS).withDefault('issues'));
   const { ordering } = useViewsDisplayStore();
   const savedViews = useViewsStore((state) => state.views);
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const hydrateViews = useViewsStore((state) => state.hydrateViews);
   const [editing, setEditing] = useState<View | undefined>();
   const [creating, setCreating] = useState(false);
   const [deleting, setDeleting] = useState<View | undefined>();

   useEffect(() => {
      if (!workspaceId || !user) return;
      void loadWorkspaceViews(workspaceId, user).then(hydrateViews);
   }, [workspaceId, user, hydrateViews]);

   const remove = (view: View) => {
      setDeleting(undefined);
      void deleteSavedView(view.id)
         .then(() => hydrateViews(savedViews.filter((entry) => entry.id !== view.id)))
         .catch(() => toast.error('You cannot delete this view.'));
   };

   const list = useMemo(() => {
      const source = savedViews.filter((view) =>
         tab === 'issues' ? view.type === 'issue' : view.type === 'project'
      );
      return [...source].sort((a, b) => {
         if (ordering === 'created') return b.createdAt.localeCompare(a.createdAt);
         if (ordering === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
         return a.name.localeCompare(b.name);
      });
   }, [tab, ordering, savedViews]);

   return (
      <div className="w-full h-full overflow-y-auto">
         <div className="flex items-center justify-between px-6 pt-3 pb-2">
            <div className="flex items-center gap-1.5">
               {TABS.map((candidate) => (
                  <button
                     key={candidate}
                     onClick={() => setTab(candidate)}
                     className={cn(
                        'px-2.5 py-1 rounded-md border font-medium capitalize transition-colors',
                        tab === candidate
                           ? 'bg-accent border-transparent'
                           : 'text-muted-foreground hover:bg-accent/50'
                     )}
                  >
                     {candidate}
                  </button>
               ))}
            </div>
            <div className="flex items-center gap-1">
               <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
                  <Plus className="mr-1 size-3.5" />
                  {t('views.newView')}
               </Button>
               <DisplayOptions />
            </div>
         </div>

         <div className="flex items-center gap-1 px-6 py-1.5 text-muted-foreground border-b">
            {t('views.name')}
            <ArrowDown className="size-3" />
         </div>

         {list.map((view) => (
            <ViewRow
               key={view.id}
               view={view}
               orgId={orgId}
               onEdit={() => setEditing(view)}
               onDelete={() => setDeleting(view)}
            />
         ))}
         {list.length === 0 && (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
               {t('states.empty')}
            </div>
         )}

         <SaveViewDialog open={creating} onOpenChange={setCreating} />
         <SaveViewDialog
            open={editing !== undefined}
            onOpenChange={(open) => {
               if (!open) setEditing(undefined);
            }}
            view={editing}
         />

         <AlertDialog
            open={deleting !== undefined}
            onOpenChange={(open) => {
               if (!open) setDeleting(undefined);
            }}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('views.deleteTitle', { name: deleting?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('views.deleteBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('selection.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                     onClick={(event) => {
                        event.preventDefault();
                        if (deleting) remove(deleting);
                     }}
                  >
                     {t('views.delete')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </div>
   );
}
