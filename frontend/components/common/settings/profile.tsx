'use client';

import { useTranslations } from 'next-intl';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { loadProfile, saveProfile, type Profile as ProfileRecord } from '@/lib/settings';
import { SaveIndicator } from './save-indicator';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useAutosave } from './use-autosave';
import { useSettingsResource } from './use-settings-resource';

/** The server's bound, mirrored so the field stops rather than the request. */
const ABOUT_MAX = 2000;

/**
 * Personal "Profile" settings.
 *
 * Only what the server actually stores. The fields this page used to show for
 * a title and a username are gone rather than left inert — a control that
 * accepts what you type and forgets it is worse than one that is not there.
 *
 * Each field saves itself, and says so. The name refuses to save while blank,
 * because an empty name is not a change anyone meant; blur puts back what the
 * server has rather than leaving the field empty and unexplained.
 *
 * The avatar is an address, not an upload, and the row says so. Berry has no
 * image hosting, and a file picker that turned out to need a URL would be a
 * worse discovery than a URL field.
 *
 * Email is shown and not editable. Changing it is an identity change that
 * needs verification, and offering a pencil that leads nowhere invites someone
 * to try.
 */
export default function Profile() {
   const t = useTranslations('workspaceAdmin.profile');
   const profile = useSettingsResource<ProfileRecord>(loadProfile);
   const me = profile.value;

   const name = useAutosave<string>({
      saved: me?.name,
      // Trailing whitespace is not a change worth a write, so the comparison
      // and the value sent agree on the trimmed form.
      equals: (a, b) => a.trim() === b.trim(),
      accepts: (next) => next.trim() !== '',
      save: async (next) => profile.set(await saveProfile({ name: next.trim() })),
   });

   const about = useAutosave<string>({
      saved: me?.description ?? '',
      equals: (a, b) => a.trim() === b.trim(),
      save: async (next) => {
         const trimmed = next.trim();
         return profile.set(await saveProfile({ description: trimmed === '' ? null : trimmed }));
      },
   });

   const avatar = useAutosave<string>({
      saved: me?.avatarUrl ?? '',
      equals: (a, b) => a.trim() === b.trim(),
      save: async (next) => {
         const trimmed = next.trim();
         return profile.set(await saveProfile({ avatarUrl: trimmed === '' ? null : trimmed }));
      },
   });

   const about_ = about.value ?? '';

   return (
      <SettingsShell title={t('title')}>
         <SettingsSection description={profile.error ?? undefined}>
            <SettingsCard>
               <SettingsRow
                  icon={
                     <Avatar className="size-8">
                        <AvatarImage src={me?.avatarUrl ?? undefined} alt="" />
                        <AvatarFallback>{me?.name?.[0] ?? '·'}</AvatarFallback>
                     </Avatar>
                  }
                  title={t('picture')}
                  description={t('pictureDescription')}
                  trailing={
                     <span className="flex items-center gap-2">
                        <SaveIndicator
                           state={avatar.state}
                           error={avatar.error}
                           onRetry={avatar.retry}
                        />
                        <Input
                           value={avatar.value ?? ''}
                           aria-label={t('pictureLabel')}
                           placeholder="https://"
                           inputMode="url"
                           disabled={profile.loading}
                           className="h-8 w-52"
                           onChange={(event) => avatar.change(event.target.value)}
                           onBlur={avatar.flush}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') avatar.revert();
                           }}
                        />
                     </span>
                  }
               />
               <SettingsRow
                  title={t('email')}
                  description={t('emailDescription')}
                  trailing={<span className="text-foreground">{me?.email ?? '—'}</span>}
               />
               <SettingsRow
                  title={t('name')}
                  trailing={
                     <span className="flex items-center gap-2">
                        <SaveIndicator state={name.state} error={name.error} onRetry={name.retry} />
                        <Input
                           value={name.value ?? ''}
                           disabled={profile.loading}
                           placeholder={t('namePlaceholder')}
                           className="h-8 w-44"
                           onChange={(event) => name.change(event.target.value)}
                           // A blank name is never written, so blur puts back
                           // what the server has instead of leaving the field
                           // empty and the reader wondering.
                           onBlur={() =>
                              (name.value ?? '').trim() === '' ? name.revert() : name.flush()
                           }
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') event.currentTarget.blur();
                              if (event.key === 'Escape') name.revert();
                           }}
                        />
                     </span>
                  }
               />
            </SettingsCard>
         </SettingsSection>

         <SettingsSection title={t('about')} description={t('aboutDescription')}>
            <SettingsCard className="p-4">
               <Textarea
                  value={about_}
                  rows={6}
                  maxLength={ABOUT_MAX}
                  aria-label={t('about')}
                  placeholder={t('aboutPlaceholder')}
                  disabled={profile.loading}
                  onChange={(event) => about.change(event.target.value)}
                  onBlur={about.flush}
               />
               <div className="mt-2 flex items-center justify-between gap-3">
                  <SaveIndicator state={about.state} error={about.error} onRetry={about.retry} />
                  <span className="text-muted-foreground tabular-nums">
                     {t('counter', { count: about_.length, max: ABOUT_MAX })}
                  </span>
               </div>
               {about_.trim() !== '' ? (
                  <Button
                     size="xs"
                     variant="ghost"
                     className="mt-2 -ml-2 w-fit"
                     onClick={() => {
                        about.change('');
                        about.flush();
                     }}
                  >
                     {t('remove')}
                  </Button>
               ) : null}
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
