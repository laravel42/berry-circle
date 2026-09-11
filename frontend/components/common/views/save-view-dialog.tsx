'use client';

import { useIssueListView } from '@/components/common/issues/use-issue-list-view';
import { Button } from '@/components/ui/button';
import {
   Dialog,
   DialogContent,
   DialogDescription,
   DialogFooter,
   DialogHeader,
   DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { View } from '@/data/views';
import { BerryApiError } from '@/lib/api';
import { createSavedView, toUiView, updateSavedView } from '@/lib/views';
import { useFilterStore } from '@/store/filter-store';
import { useSessionStore } from '@/store/session-store';
import { useViewsStore } from '@/store/views-store';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

const SCOPES = ['all', 'assigned', 'created', 'agents'] as const;

/**
 * Saves the current filters and layout as a view, or writes them back into the
 * view being read.
 *
 * An edit sends the revision the view was loaded with, so two people saving
 * the same view get told rather than one silently overwriting the other.
 */
export function SaveViewDialog({
   open,
   onOpenChange,
   view,
}: {
   open: boolean;
   onOpenChange: (open: boolean) => void;
   /** When set, the dialog edits this view instead of creating one. */
   view?: View;
}) {
   const t = useTranslations('issueLists');
   const workspaceId = useSessionStore((state) => state.workspace?.id ?? '');
   const user = useSessionStore((state) => state.user);
   const { filters } = useFilterStore();
   const listView = useIssueListView();
   const { views, hydrateViews } = useViewsStore();
   const [tab] = useQueryState('tab', parseAsString);
   const [name, setName] = useState(view?.name ?? '');
   const [shared, setShared] = useState(view?.visibility === 'workspace');
   const [scope, setScope] = useState<string>(view?.scope ?? tab ?? 'all');
   const [saving, setSaving] = useState(false);

   useEffect(() => {
      if (!open) return;
      setName(view?.name ?? '');
      setShared(view?.visibility === 'workspace');
      setScope(view?.scope ?? tab ?? 'all');
   }, [open, view, tab]);

   const query = {
      filters: JSON.parse(JSON.stringify(filters)) as unknown,
      scope,
   };
   const display = {
      layout: listView.mode,
      grouping: listView.grouping,
      ordering: listView.ordering,
      direction: listView.direction,
      icon: view?.icon ?? '◆',
   };

   const save = () => {
      if (!user || saving) return;
      setSaving(true);
      const request = view
         ? updateSavedView(view.id, {
              name: name.trim(),
              visibility: shared ? 'workspace' : 'private',
              query,
              display,
              revision: view.revision,
           })
         : createSavedView({
              workspaceId,
              name: name.trim(),
              visibility: shared ? 'workspace' : 'private',
              query,
              display,
           });

      void request
         .then((saved) => {
            const next = toUiView(saved, user, user.id);
            hydrateViews(
               view ? views.map((entry) => (entry.id === next.id ? next : entry)) : [next, ...views]
            );
            setName('');
            onOpenChange(false);
            toast.success(t('views.saved'));
         })
         .catch((cause: unknown) => {
            const stale =
               cause instanceof BerryApiError &&
               (cause.status === 409 || cause.code.includes('CONFLICT'));
            toast.error(stale ? t('views.conflict') : t('states.loadFailed'));
         })
         .finally(() => setSaving(false));
   };

   const scopeLabel: Record<string, string> = {
      all: t('scope.all'),
      assigned: t('scope.assigned'),
      created: t('scope.created'),
      agents: t('scope.agents'),
   };
   const layoutLabel: Record<string, string> = {
      list: t('mode.list'),
      grid: t('mode.board'),
      table: t('mode.table'),
      swimlane: t('mode.swimlane'),
      gantt: t('mode.gantt'),
   };

   return (
      <Dialog open={open} onOpenChange={onOpenChange}>
         <DialogContent>
            <DialogHeader>
               <DialogTitle>{view ? t('views.edit') : t('filters.saveAsView')}</DialogTitle>
               <DialogDescription>
                  {t('views.filtersSummary', { count: filters.length })}
               </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-3">
               <div className="flex flex-col gap-1.5">
                  <Label htmlFor="view-name">{t('views.name')}</Label>
                  <Input
                     id="view-name"
                     value={name}
                     onChange={(event) => setName(event.target.value)}
                  />
               </div>

               <div className="flex items-center justify-between">
                  <Label htmlFor="view-shared">{t('views.shared')}</Label>
                  <Switch id="view-shared" checked={shared} onCheckedChange={setShared} />
               </div>

               <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="view-scope">{t('views.scope')}</Label>
                  <Select value={scope} onValueChange={setScope}>
                     <SelectTrigger id="view-scope" className="h-8 w-48">
                        <SelectValue />
                     </SelectTrigger>
                     <SelectContent>
                        {SCOPES.map((entry) => (
                           <SelectItem key={entry} value={entry}>
                              {scopeLabel[entry]}
                           </SelectItem>
                        ))}
                     </SelectContent>
                  </Select>
               </div>

               {/* The layout and display settings are taken from the list as it
                   stands; showing them is what makes "save the view" mean
                   something specific rather than a guess. */}
               <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t('views.layout')}</span>
                  <span>{layoutLabel[listView.mode]}</span>
               </div>
               <div className="flex items-center justify-between text-muted-foreground">
                  <span>{t('views.displayDefaults')}</span>
                  <span>
                     {listView.grouping} · {listView.ordering} · {listView.direction}
                  </span>
               </div>
            </div>

            <DialogFooter>
               <Button onClick={save} disabled={!name.trim() || !workspaceId || saving}>
                  {t('views.save')}
               </Button>
            </DialogFooter>
         </DialogContent>
      </Dialog>
   );
}
