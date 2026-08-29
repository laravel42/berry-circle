'use client';

import { Switch } from '@/components/ui/switch';
import {
   loadNotifications,
   saveNotification,
   type NotificationKey,
   type NotificationSwitches,
} from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * What Berry tells you about, in the workspace you are in.
 *
 * Per workspace because the answer usually differs: every mention in the one
 * you work in, and nothing from the one you were invited to. The page says
 * which workspace it is editing rather than leaving that to be inferred.
 *
 * The email, Slack and mobile rows this page used to show are gone. Berry
 * delivers to the inbox and nowhere else yet, and a "Enabled for all
 * notifications" line under a channel that sends nothing is a claim, not a
 * setting. Addresses for the day it does deliver are under Connected accounts.
 */

const ROWS: Array<{ key: NotificationKey; title: string; description: string }> = [
   {
      key: 'assignments',
      title: 'Assigned to me',
      description: 'A task is assigned to you, by a person or by a plan.',
   },
   {
      key: 'mentions',
      title: 'Mentions',
      description: 'Someone names you in a comment or a description.',
   },
   {
      key: 'comments',
      title: 'Comments',
      description: 'A new comment on a task you are on.',
   },
   {
      key: 'statusChanges',
      title: 'Status changes',
      description: 'A task you are on moves, including into review.',
   },
   {
      key: 'approvals',
      title: 'Approvals',
      description: 'A decision is waiting on you, or one you asked for is answered.',
   },
   {
      key: 'agentActivity',
      title: 'Agent activity',
      description: 'A run on your task finishes, fails, or opens a pull request.',
   },
   {
      key: 'goals',
      title: 'Goals',
      description: 'A goal you follow is planned, blocked or completed.',
   },
   {
      key: 'updates',
      title: 'Everything else',
      description: 'Workspace changes that do not fit the rest.',
   },
];

export default function AccountNotifications() {
   const workspace = useSessionStore((state) => state.workspace);
   const workspaceId = workspace?.id ?? '';

   const switches = useSettingsResource<NotificationSwitches>(
      () =>
         workspaceId
            ? loadNotifications(workspaceId)
            : Promise.reject(new Error('No workspace is selected.')),
      [workspaceId]
   );

   const toggle = (key: NotificationKey, enabled: boolean) => {
      if (!switches.value) return;
      void switches.mutate({ ...switches.value, [key]: enabled }, () =>
         saveNotification(workspaceId, key, enabled)
      );
   };

   return (
      <SettingsShell
         title="Notifications"
         description={
            workspace
               ? `What Berry tells you about in ${workspace.name}. These are per workspace.`
               : 'Select a workspace to change its notifications.'
         }
      >
         <SettingsSection title="In your inbox" description={switches.error ?? undefined}>
            <SettingsCard>
               {ROWS.map((row) => (
                  <SettingsRow
                     key={row.key}
                     title={row.title}
                     description={row.description}
                     trailing={
                        <Switch
                           checked={switches.value?.[row.key] ?? true}
                           disabled={switches.loading || switches.saving || !workspaceId}
                           onCheckedChange={(enabled) => toggle(row.key, enabled)}
                        />
                     }
                  />
               ))}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
