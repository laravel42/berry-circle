'use client';

import { CustomizeSidebarDialog } from '@/components/layout/sidebar/customize-sidebar-dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { writeLocaleCookie } from '@/lib/i18n/client-locale';
import { LOCALE_NAMES, LOCALES, isLocale } from '@/lib/i18n/locales';
import { loadUserSettings, saveUserSettings, type UserSettings } from '@/lib/settings';
import { useSessionStore } from '@/store/session-store';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { SelectMenu, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { ThemePreferences } from './theme-preferences';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Preferences" settings.
 *
 * Four settings, because four is what the server stores: language, theme,
 * timezone and reduced motion. Anything the server does not store is not
 * offered — a switch that accepts a click and forgets it teaches people that
 * the settings page does not work.
 *
 * Sidebar customisation stays because it is real: it is stored in the browser
 * by `sidebar-prefs-store`, and it says so.
 */
export default function Preferences() {
   const t = useTranslations('settings.preferences');
   const rendered = useLocale();
   const router = useRouter();
   const setPreferredLocale = useSessionStore((state) => state.setPreferredLocale);
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

   const changeLocale = (locale: string) => {
      if (!isLocale(locale)) return;
      change({ locale });
      // The store first, or LocaleSync would see the old account value and
      // switch straight back.
      setPreferredLocale(locale);
      writeLocaleCookie(locale);
      router.refresh();
   };

   return (
      <SettingsShell title={t('title')}>
         <SettingsSection title={t('general')} description={settings.error ?? undefined}>
            <SettingsCard>
               <SettingsRow
                  title={t('language')}
                  description={t('languageDescription')}
                  trailing={
                     <SelectMenu
                        options={[...LOCALES]}
                        labels={LOCALE_NAMES}
                        value={settings.value?.locale ?? rendered}
                        disabled={settings.loading || settings.saving}
                        onChange={changeLocale}
                     />
                  }
               />
               <SettingsRow
                  title={t('timezone')}
                  description={t('timezoneDescription')}
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

         <SettingsSection title={t('interface')}>
            <SettingsCard>
               <SettingsRow
                  title={t('sidebar')}
                  description={t('sidebarDescription')}
                  trailing={
                     <Button size="xs" variant="ghost" onClick={() => setCustomizeOpen(true)}>
                        {t('customize')}
                     </Button>
                  }
               />
               <SettingsRow
                  title={t('reduceMotion')}
                  description={t('reduceMotionDescription')}
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
