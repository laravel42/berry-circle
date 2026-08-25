'use client';

import { Button } from '@/components/ui/button';
import { ArrowUpRight } from 'lucide-react';
import { INTEGRATION_LOGOS } from './integration-logos';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';

const SlackLogo = INTEGRATION_LOGOS['slack'];
const GoogleCalendarLogo = INTEGRATION_LOGOS['google-calendar'];
const NotionLogo = INTEGRATION_LOGOS['notion'];
const GithubLogo = INTEGRATION_LOGOS['github'];

const ConnectTrailing = () => (
   <Button size="xs" variant="ghost">
      Connect
      <ArrowUpRight className="size-3.5" />
   </Button>
);

/** Personal "Connected accounts" settings. */
export default function AccountConnections() {
   return (
      <SettingsShell
         title="Connected accounts"
         description="Connect your user accounts to sync attribution of your actions between apps"
      >
         <SettingsSection>
            <SettingsCard>
               <SettingsRow
                  icon={<SlackLogo className="size-4" />}
                  title="Slack"
                  description="Sync your message attribution, and receive notifications in Slack"
                  trailing={<ConnectTrailing />}
               />
            </SettingsCard>
            <SettingsCard>
               <SettingsRow
                  icon={<GoogleCalendarLogo className="size-4" />}
                  title="Google Calendar"
                  description="Sync your calendar out-of-office status to Berry"
                  trailing={<ConnectTrailing />}
               />
            </SettingsCard>
            <SettingsCard>
               <SettingsRow
                  icon={<NotionLogo className="size-4" />}
                  title="Notion"
                  description="Preview tasks, projects, and views within Notion"
                  trailing={<ConnectTrailing />}
               />
            </SettingsCard>
            <SettingsCard>
               <SettingsRow
                  icon={<GithubLogo className="size-4" />}
                  title="GitHub"
                  description="Review code in Berry and sync attribution of your git-related actions"
                  trailing={<ConnectTrailing />}
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
