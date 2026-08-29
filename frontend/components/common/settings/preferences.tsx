'use client';

import { CustomizeSidebarDialog } from '@/components/layout/sidebar/customize-sidebar-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { loadUserSettings, saveUserSettings, type UserSettings } from '@/lib/settings';
import { useMemo, useState } from 'react';
import { SelectMenu, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { ThemePreferences } from './theme-preferences';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Preferences" settings.
 *
 * Three settings, because three is what the server stores: theme, timezone
 * and reduced motion. This page used to show a dozen more — font size,
 * pointer cursors, first day of the week, auto-assign — none of which were
 * written anywhere. They are gone rather than left inert: a switch that
 * accepts a click and forgets it is worse than one that is not offered, and
 * it teaches people that the settings page does not work.
 *
 * Sidebar customisation stays because it is real: it is stored in the browser
 * by `sidebar-prefs-store`, and it says so.
 */
export default function Preferences() {
   const [customizeOpen, setCustomizeOpen] = useState(false);
   const settings = useSettingsResource<UserSettings>(loadUserSettings);

   // The browser's own list, which is the only list guaranteed to match what
   // the server will accept — it validates against the same IANA database.
   const zones = useMemo(() => {
      const supported =
         typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
      const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const current = settings.value?.timezone;
      return [...new Set([current, here, 'UTC', ...supported].filter(Boolean))] as string[];
   }, [settings.value?.timezone]);

   const change = (patch: Partial<UserSettings>) => {
      if (!settings.value) return;
      void settings.mutate({ ...settings.value, ...patch }, () => saveUserSettings(patch));
   };

   return (
      <SettingsShell title="Preferences">
         <SettingsSection
            title="General"
            description={settings.error ?? undefined}
         >
            <SettingsCard>
               <SettingsRow
                  title="Time zone"
                  description="Dates and times across Berry are shown in this zone."
                  trailing={
                     <SelectMenu
                        options={zones}
                        value={settings.value?.timezone ?? 'UTC'}
                        disabled={settings.loading || settings.saving}
                        onChange={(timezone) => change({ timezone })}
                     />
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title="Interface and theme">
            <SettingsCard>
               <SettingsRow
                  title="App sidebar"
                  description="Pin, hide and reorder rail items. Stored in this browser."
                  trailing={
                     <Button size="xs" variant="ghost" onClick={() => setCustomizeOpen(true)}>
                        Customize
                     </Button>
                  }
               />
               <SettingsRow
                  title="Reduce motion"
                  description="Turn off the animations Berry uses to show work moving."
                  trailing={
                     <Switch
                        checked={settings.value?.reducedMotion ?? false}
                        disabled={settings.loading || settings.saving}
                        onCheckedChange={(reducedMotion) => change({ reducedMotion })}
                     />
                  }
               />
            </SettingsCard>
            <ThemePreferences
               // Kept on the account as well as in the browser, so a second
               // device opens in the theme this one chose.
               onChange={(theme) => change({ theme })}
            />
         </SettingsSection>
         <CustomizeSidebarDialog open={customizeOpen} onOpenChange={setCustomizeOpen} />
      </SettingsShell>
   );
}
