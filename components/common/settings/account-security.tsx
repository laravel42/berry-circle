'use client';

import { Button } from '@/components/ui/button';
import { KeyRound } from 'lucide-react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';

/** Personal "Security & access" settings (sessions, passkeys, API keys). */
export default function AccountSecurity() {
   return (
      <SettingsShell title="Security & access">
         <SettingsSection title="Sessions" description="Devices logged into your account">
            <SettingsCard>
               <SettingsRow
                  title="No sessions yet"
                  description="Active sessions will appear here"
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Passkeys"
            description="Passkeys are a secure way to sign in to your account"
         >
            <SettingsCard>
               <SettingsRow
                  title="No passkeys registered"
                  trailing={
                     <Button size="xs" variant="ghost">
                        New passkey
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Personal API keys"
            description="Use the API to build your own integrations"
         >
            <SettingsCard>
               <SettingsRow
                  icon={<KeyRound className="size-4" />}
                  title="No API keys"
                  trailing={
                     <Button size="xs" variant="ghost">
                        New API key
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Commit signing key"
            description="Coding sessions use this key to sign your commits"
         >
            <SettingsCard>
               <SettingsRow
                  title="No signing key added"
                  trailing={
                     <Button size="xs" variant="ghost">
                        Add key
                     </Button>
                  }
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
