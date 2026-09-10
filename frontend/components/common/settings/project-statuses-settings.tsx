'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   Select,
   SelectContent,
   SelectItem,
   SelectTrigger,
   SelectValue,
} from '@/components/ui/select';
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
 * Two different things, and the page says so rather than blurring them.
 *
 * Task statuses are rows in `issue_status_definitions`. A workspace can add
 * its own, each inside one fixed category, and rename, recolour, reorder or
 * archive them. The `category` of a status cannot change: the board's columns
 * and the run ledger both address a status by category, so moving one would
 * move every task that is in it. Built-in statuses cannot be archived.
 *
 * Project statuses are a fixed vocabulary in the server, not a table. They are
 * shown read-only, because a page that let someone type into them would be
 * offering a change nothing can store.
 */

const PROJECT_STATUSES = [
   { name: 'Planned', description: 'Agreed, not started.' },
   { name: 'Active', description: 'Work is happening.' },
   { name: 'Paused', description: 'Deliberately stopped, not abandoned.' },
   { name: 'Completed', description: 'Finished.' },
   { name: 'Cancelled', description: 'Stopped and not coming back.' },
];

type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export default function ProjectStatusesSettings() {
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';

   const statuses = useSettingsResource<WorkspaceStatus[]>(
      () =>
         workspaceId
            ? loadStatuses(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const [newName, setNewName] = useState('');
   const [newCategory, setNewCategory] = useState<StatusCategory>('in_review');

   const rename = (status: WorkspaceStatus, next: string) => {
      const trimmed = next.trim();
      if (trimmed === '' || trimmed === status.name) return;
      void statuses.mutate(
         (statuses.value ?? []).map((entry) =>
            entry.id === status.id ? { ...entry, name: trimmed } : entry
         ),
         () => updateStatus(workspaceId, status.id, { name: trimmed }).then(() => undefined)
      );
   };

   const add = async () => {
      if (!newName.trim()) return;
      try {
         const created = await createStatus(workspaceId, {
            name: newName.trim(),
            category: newCategory,
            color: '#8b5cf6',
         });
         statuses.set(
            [...(statuses.value ?? []), created].sort((a, b) => a.sortOrder - b.sortOrder)
         );
         setNewName('');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The status could not be created.');
      }
   };

   const archive = (status: WorkspaceStatus) =>
      void statuses.mutate(
         (statuses.value ?? []).filter((entry) => entry.id !== status.id),
         () => archiveStatus(workspaceId, status.id)
      );

   const move = (index: number, delta: -1 | 1) => {
      const list = [...(statuses.value ?? [])];
      const target = index + delta;
      const current = list[index];
      const other = list[target];
      if (!current || !other) return;
      list[index] = other;
      list[target] = current;
      void statuses.mutate(list, () =>
         reorderStatuses(
            workspaceId,
            list.map((entry) => entry.id)
         )
      );
   };

   const list = statuses.value ?? [];

   return (
      <SettingsShell
         title="Statuses"
         description="What a task can be in, and what a project can be in."
      >
         <SettingsSection
            title="Task statuses"
            description={
               statuses.error ??
               'Add your own inside a board column, then rename, recolour or reorder them. The column a status belongs to cannot change.'
            }
         >
            <SettingsCard>
               <SettingsRow
                  title={
                     <Input
                        value={newName}
                        placeholder="New status name"
                        aria-label="New status name"
                        className="h-7 w-56"
                        onChange={(event) => setNewName(event.target.value)}
                        onKeyDown={(event) => {
                           if (event.key === 'Enter') void add();
                        }}
                     />
                  }
                  trailing={
                     <div className="flex items-center gap-2">
                        <Select
                           value={newCategory}
                           onValueChange={(value) => setNewCategory(value as StatusCategory)}
                        >
                           <SelectTrigger className="h-7 w-36" aria-label="Board column">
                              <SelectValue />
                           </SelectTrigger>
                           <SelectContent>
                              {STATUS_CATEGORIES.map((category) => (
                                 <SelectItem key={category} value={category}>
                                    {category.replace(/_/g, ' ')}
                                 </SelectItem>
                              ))}
                           </SelectContent>
                        </Select>
                        <Button
                           size="sm"
                           disabled={!workspaceId || newName.trim() === '' || statuses.saving}
                           onClick={() => void add()}
                        >
                           Add status
                        </Button>
                     </div>
                  }
               />
               {statuses.loading ? <SettingsRow title="Loading…" /> : null}
               {list.map((status, index) => (
                  <SettingsRow
                     key={status.id}
                     icon={
                        <span
                           className="size-2.5 rounded-full"
                           style={{ backgroundColor: status.color }}
                           aria-hidden
                        />
                     }
                     title={
                        <Input
                           defaultValue={status.name}
                           disabled={statuses.saving}
                           aria-label={`Name for ${status.key}`}
                           className="h-7 w-56 border-transparent bg-transparent px-1 hover:border-border"
                           onBlur={(event) => rename(status, event.target.value)}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') {
                                 event.currentTarget.value = status.name;
                                 event.currentTarget.blur();
                              }
                           }}
                        />
                     }
                     description={`Board column: ${status.category.replace(/_/g, ' ')}`}
                     trailing={
                        <div className="flex items-center gap-1">
                           <span className="mr-2 font-mono text-muted-foreground">
                              {status.color}
                           </span>
                           <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Move ${status.name} up`}
                              disabled={index === 0 || statuses.saving}
                              onClick={() => move(index, -1)}
                           >
                              ↑
                           </Button>
                           <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Move ${status.name} down`}
                              disabled={index === list.length - 1 || statuses.saving}
                              onClick={() => move(index, 1)}
                           >
                              ↓
                           </Button>
                           {!status.isSystem ? (
                              <Button
                                 variant="ghost"
                                 size="sm"
                                 disabled={statuses.saving}
                                 onClick={() => archive(status)}
                              >
                                 Archive
                              </Button>
                           ) : null}
                        </div>
                     }
                  />
               ))}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Project statuses"
            description="Fixed. These are part of what a project means, not a workspace preference."
         >
            <SettingsCard>
               {PROJECT_STATUSES.map((status) => (
                  <SettingsRow
                     key={status.name}
                     title={status.name}
                     description={status.description}
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
