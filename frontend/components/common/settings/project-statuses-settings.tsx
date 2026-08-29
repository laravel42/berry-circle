'use client';

import { Input } from '@/components/ui/input';
import { loadStatuses, updateStatus, type WorkspaceStatus } from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Workspace "Statuses": what a task can be in, and what a project can be in.
 *
 * Two different things, and the page says so rather than blurring them.
 *
 * Task statuses are rows in `issue_status_definitions` and can be renamed and
 * recoloured. Their `key` and `category` cannot change: the board's columns
 * and the run ledger both address a status by category, so renaming one would
 * move every task that is in it.
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

   return (
      <SettingsShell
         title="Statuses"
         description="What a task can be in, and what a project can be in."
      >
         <SettingsSection
            title="Task statuses"
            description={
               statuses.error ??
               'Rename or recolour these. What each one means to the board cannot change.'
            }
         >
            <SettingsCard>
               {statuses.loading ? <SettingsRow title="Loading…" /> : null}
               {(statuses.value ?? []).map((status) => (
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
                        <span className="font-mono text-muted-foreground">{status.color}</span>
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
