'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
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
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { loadWorkspace } from '@/lib/workspaces';
import {
   archiveStatus,
   createStatus,
   loadStatuses,
   reorderStatuses,
   STATUS_CATEGORIES,
   updateStatus,
   type WorkspaceStatus,
} from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Statuses": what a task can be in, and what a project can be in.
 *
 * Task statuses are grouped by their category, because the category is the
 * part that matters and the part nobody can change. The board's columns and
 * the run ledger both address a status by category, so a status named
 * "Waiting on design" inside `blocked` is a name over a meaning the rest of
 * Berry already acts on — which is why each group says what its category makes
 * an agent do. A flat list hid all of that behind a caption.
 *
 * Reordering is a drag within a group. Crossing a group was possible with the
 * old arrows and meant nothing, since order only ever applies among statuses
 * that share a column.
 *
 * Everything here is `settings.write`, so a member sees the same page without
 * the controls rather than a page whose every click 403s.
 *
 * Project statuses are a fixed vocabulary in the server, not a table. They are
 * shown read-only, because a page that let someone type into them would be
 * offering a change nothing can store.
 */

const PROJECT_STATUSES = ['planned', 'active', 'paused', 'completed', 'cancelled'] as const;

const PALETTE = [
   '#6366f1',
   '#8b5cf6',
   '#f97316',
   '#347b5a',
   '#9b6715',
   '#397caf',
   '#b4436c',
   '#4a5568',
];

type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export default function ProjectStatusesSettings() {
   const t = useTranslations('workspaceAdmin.statuses');
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';

   const statuses = useSettingsResource<WorkspaceStatus[]>(
      () =>
         workspaceId
            ? loadStatuses(workspaceId, true)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   // The role decides whether any of this is editable. Read separately from
   // the session workspace, which does not carry it.
   const record = useSettingsResource(
      () =>
         workspaceId
            ? loadWorkspace(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );
   const canEdit = record.value?.role === 'owner' || record.value?.role === 'admin';

   const [newName, setNewName] = useState('');
   const [newCategory, setNewCategory] = useState<StatusCategory>('in_review');
   const [newDescription, setNewDescription] = useState('');
   const [newColor, setNewColor] = useState(PALETTE[1]!);
   const [showArchived, setShowArchived] = useState(false);
   const [archiving, setArchiving] = useState<WorkspaceStatus | null>(null);
   const [dragged, setDragged] = useState<string | null>(null);

   const all = useMemo(() => statuses.value ?? [], [statuses.value]);
   const active = useMemo(() => all.filter((entry) => !entry.archivedAt), [all]);
   const archived = useMemo(() => all.filter((entry) => entry.archivedAt), [all]);

   const grouped = useMemo(() => {
      const byCategory = new Map<string, WorkspaceStatus[]>();
      for (const category of STATUS_CATEGORIES) byCategory.set(category, []);
      for (const status of active) {
         const bucket = byCategory.get(status.category);
         if (bucket) bucket.push(status);
         else byCategory.set(status.category, [status]);
      }
      for (const bucket of byCategory.values()) bucket.sort((a, b) => a.sortOrder - b.sortOrder);
      return byCategory;
   }, [active]);

   const replace = (next: WorkspaceStatus) =>
      all.map((entry) => (entry.id === next.id ? next : entry));

   const patch = (status: WorkspaceStatus, change: Partial<WorkspaceStatus>) =>
      void statuses.mutate(replace({ ...status, ...change }), () =>
         updateStatus(workspaceId, status.id, {
            ...(change.name === undefined ? {} : { name: change.name }),
            ...(change.color === undefined ? {} : { color: change.color }),
            ...(change.description === undefined ? {} : { description: change.description }),
         }).then(() => undefined)
      );

   const add = async () => {
      if (!newName.trim()) return;
      try {
         const created = await createStatus(workspaceId, {
            name: newName.trim(),
            category: newCategory,
            color: newColor,
            description: newDescription.trim() || null,
         });
         statuses.set([...all, created]);
         setNewName('');
         setNewDescription('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('createFailed'));
      }
   };

   const archive = (status: WorkspaceStatus) => {
      setArchiving(null);
      void statuses.mutate(replace({ ...status, archivedAt: new Date().toISOString() }), () =>
         archiveStatus(workspaceId, status.id)
      );
   };

   const restore = async (status: WorkspaceStatus) => {
      try {
         statuses.set(replace(await updateStatus(workspaceId, status.id, { archived: false })));
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : t('restoreFailed'));
      }
   };

   /**
    * Drop `dragged` where `target` sits, inside one category.
    *
    * The order endpoint takes every active status exactly once, so the group
    * is rearranged and then spliced back into the whole list in the order the
    * categories are listed here.
    */
   const drop = (category: string, targetId: string) => {
      if (!dragged || dragged === targetId) return;
      const bucket = [...(grouped.get(category) ?? [])];
      const from = bucket.findIndex((entry) => entry.id === dragged);
      const to = bucket.findIndex((entry) => entry.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = bucket.splice(from, 1);
      bucket.splice(to, 0, moved!);

      const next = [...STATUS_CATEGORIES, ...grouped.keys()]
         .filter((value, index, list) => list.indexOf(value) === index)
         .flatMap((entry) => (entry === category ? bucket : (grouped.get(entry) ?? [])));

      setDragged(null);
      void statuses.mutate([...next, ...archived], () =>
         reorderStatuses(
            workspaceId,
            next.map((entry) => entry.id)
         ).then(() => undefined)
      );
   };

   const colourPicker = (value: string, onPick: (colour: string) => void, label: string) => (
      <Popover>
         <PopoverTrigger
            aria-label={label}
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: value }}
         />
         <PopoverContent align="start" className="w-auto p-3">
            <div className="grid grid-cols-4 gap-2">
               {PALETTE.map((colour) => (
                  <button
                     key={colour}
                     type="button"
                     aria-label={colour}
                     className="size-6 rounded-full ring-offset-2 ring-offset-popover hover:ring-2 hover:ring-ring"
                     style={{ backgroundColor: colour }}
                     onClick={() => onPick(colour)}
                  />
               ))}
            </div>
            <label className="mt-3 flex items-center gap-2">
               <input
                  type="color"
                  value={value}
                  aria-label={t('customColour')}
                  className="size-7 cursor-pointer rounded border bg-transparent"
                  onChange={(event) => onPick(event.target.value.toLowerCase())}
               />
               <span className="text-muted-foreground">{t('customColour')}</span>
            </label>
         </PopoverContent>
      </Popover>
   );

   const row = (status: WorkspaceStatus, draggable: boolean) => (
      <div
         key={status.id}
         draggable={draggable}
         onDragStart={() => setDragged(status.id)}
         onDragOver={(event) => draggable && event.preventDefault()}
         onDrop={() => draggable && drop(status.category, status.id)}
         className={draggable ? 'cursor-grab active:cursor-grabbing' : undefined}
      >
         <SettingsRow
            icon={
               canEdit ? (
                  colourPicker(
                     status.color,
                     (colour) => patch(status, { color: colour }),
                     t('changeColour', { name: status.name })
                  )
               ) : (
                  <span
                     className="size-2.5 rounded-full"
                     style={{ backgroundColor: status.color }}
                     aria-hidden
                  />
               )
            }
            title={
               canEdit ? (
                  <Input
                     defaultValue={status.name}
                     disabled={statuses.saving}
                     aria-label={t('nameFor', { key: status.key })}
                     className="h-7 w-56 border-transparent bg-transparent px-1 hover:border-border"
                     onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next !== '' && next !== status.name) patch(status, { name: next });
                     }}
                     onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur();
                        if (event.key === 'Escape') {
                           event.currentTarget.value = status.name;
                           event.currentTarget.blur();
                        }
                     }}
                  />
               ) : (
                  status.name
               )
            }
            description={
               canEdit ? (
                  <Input
                     defaultValue={status.description ?? ''}
                     disabled={statuses.saving}
                     placeholder={t('descriptionPlaceholder')}
                     aria-label={t('descriptionFor', { name: status.name })}
                     className="h-7 w-full border-transparent bg-transparent px-1 hover:border-border"
                     onBlur={(event) => {
                        const next = event.target.value.trim();
                        if (next !== (status.description ?? '')) {
                           patch(status, { description: next || null });
                        }
                     }}
                  />
               ) : (
                  (status.description ?? undefined)
               )
            }
            trailing={
               <div className="flex items-center gap-1">
                  <span className="mr-2 font-mono text-muted-foreground">{status.color}</span>
                  {status.archivedAt ? (
                     canEdit ? (
                        <Button variant="ghost" size="sm" onClick={() => void restore(status)}>
                           {t('restore')}
                        </Button>
                     ) : null
                  ) : canEdit && !status.isSystem ? (
                     <Button
                        variant="ghost"
                        size="sm"
                        disabled={statuses.saving}
                        onClick={() => setArchiving(status)}
                     >
                        {t('archive')}
                     </Button>
                  ) : null}
               </div>
            }
         />
      </div>
   );

   return (
      <SettingsShell title={t('title')} description={t('lead')}>
         {!canEdit && !record.loading ? (
            <p className="px-1 text-muted-foreground">{t('readOnly')}</p>
         ) : null}

         {canEdit ? (
            <SettingsSection title={t('addTitle')} description={statuses.error ?? t('addLead')}>
               <SettingsCard>
                  <SettingsRow
                     icon={colourPicker(newColor, setNewColor, t('newColour'))}
                     title={
                        <Input
                           value={newName}
                           placeholder={t('newName')}
                           aria-label={t('newName')}
                           className="h-7 w-56"
                           onChange={(event) => setNewName(event.target.value)}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') void add();
                           }}
                        />
                     }
                     description={
                        <Input
                           value={newDescription}
                           placeholder={t('descriptionPlaceholder')}
                           aria-label={t('newDescription')}
                           className="h-7 w-full"
                           onChange={(event) => setNewDescription(event.target.value)}
                        />
                     }
                     trailing={
                        <div className="flex items-center gap-2">
                           <Select
                              value={newCategory}
                              onValueChange={(value) => setNewCategory(value as StatusCategory)}
                           >
                              <SelectTrigger className="h-7 w-36" aria-label={t('category')}>
                                 <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                 {STATUS_CATEGORIES.map((category) => (
                                    <SelectItem key={category} value={category}>
                                       {t(`category_${category}`)}
                                    </SelectItem>
                                 ))}
                              </SelectContent>
                           </Select>
                           <Button
                              size="sm"
                              disabled={!workspaceId || newName.trim() === '' || statuses.saving}
                              onClick={() => void add()}
                           >
                              {t('add')}
                           </Button>
                        </div>
                     }
                  />
                  <SettingsRow description={t('categoryIsFixed')} title="" />
               </SettingsCard>
            </SettingsSection>
         ) : null}

         {STATUS_CATEGORIES.map((category) => {
            const bucket = grouped.get(category) ?? [];
            if (bucket.length === 0) return null;
            return (
               <SettingsSection
                  key={category}
                  title={t(`category_${category}`)}
                  description={t(`agentNote_${category}`)}
               >
                  <SettingsCard>{bucket.map((status) => row(status, canEdit))}</SettingsCard>
               </SettingsSection>
            );
         })}

         {archived.length > 0 ? (
            <SettingsSection title={t('archivedTitle')} description={t('archivedLead')}>
               <SettingsCard>
                  <SettingsRow
                     title={t('showArchived', { count: archived.length })}
                     trailing={<Switch checked={showArchived} onCheckedChange={setShowArchived} />}
                  />
                  {showArchived ? archived.map((status) => row(status, false)) : null}
               </SettingsCard>
            </SettingsSection>
         ) : null}

         <SettingsSection title={t('projectTitle')} description={t('projectLead')}>
            <SettingsCard>
               {PROJECT_STATUSES.map((name) => (
                  <SettingsRow
                     key={name}
                     title={t(`project_${name}`)}
                     description={t(`projectNote_${name}`)}
                  />
               ))}
            </SettingsCard>
         </SettingsSection>

         <AlertDialog
            open={archiving !== null}
            onOpenChange={(open) => !open && setArchiving(null)}
         >
            <AlertDialogContent>
               <AlertDialogHeader>
                  <AlertDialogTitle>
                     {t('archiveTitle', { name: archiving?.name ?? '' })}
                  </AlertDialogTitle>
                  <AlertDialogDescription>{t('archiveBody')}</AlertDialogDescription>
               </AlertDialogHeader>
               <AlertDialogFooter>
                  <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                  <AlertDialogAction onClick={() => archiving && archive(archiving)}>
                     {t('archive')}
                  </AlertDialogAction>
               </AlertDialogFooter>
            </AlertDialogContent>
         </AlertDialog>
      </SettingsShell>
   );
}
