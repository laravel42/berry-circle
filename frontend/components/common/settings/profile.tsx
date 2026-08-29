'use client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { loadProfile, saveProfile, type Profile as ProfileRecord } from '@/lib/settings';
import { useEffect, useState } from 'react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Profile" settings.
 *
 * Only what the server actually stores: a name and an avatar. The fields this
 * page used to show for a title and a username are gone rather than left
 * inert — a control that accepts what you type and forgets it is worse than
 * one that is not there.
 *
 * Email is shown and not editable. Changing it is an identity change that
 * needs verification, and offering a pencil that leads nowhere invites
 * someone to try.
 */
export default function Profile() {
   const profile = useSettingsResource<ProfileRecord>(loadProfile);
   const [name, setName] = useState('');

   // Keyed on the name rather than the object: the field follows what the
   // server says, but re-seeding on every render of the same value would fight
   // whoever is typing.
   const saved = profile.value?.name;
   useEffect(() => {
      if (saved !== undefined) setName(saved);
   }, [saved]);

   const commit = async () => {
      const trimmed = name.trim();
      if (!profile.value || trimmed === '' || trimmed === profile.value.name) {
         // Reverted rather than saved: an empty name is not a change someone
         // meant, and the field should not sit there empty afterwards.
         setName(profile.value?.name ?? '');
         return;
      }
      await profile.mutate({ ...profile.value, name: trimmed }, () =>
         saveProfile({ name: trimmed })
      );
   };

   const me = profile.value;

   return (
      <SettingsShell title="Profile">
         <SettingsSection>
            <SettingsCard>
               <SettingsRow
                  title="Profile picture"
                  description={profile.error ?? undefined}
                  trailing={
                     <Avatar className="size-9">
                        <AvatarImage src={me?.avatarUrl ?? undefined} alt={me?.name ?? ''} />
                        <AvatarFallback>{me?.name?.[0] ?? '·'}</AvatarFallback>
                     </Avatar>
                  }
               />
               <SettingsRow
                  title="Email"
                  description="Changing this needs a verification step Berry does not have yet."
                  trailing={
                     <span className="text-foreground">{me?.email ?? '—'}</span>
                  }
               />
               <SettingsRow
                  title="Full name"
                  trailing={
                     <Input
                        value={name}
                        disabled={profile.loading || profile.saving}
                        placeholder="Your name"
                        className="h-8 w-44"
                        onChange={(event) => setName(event.target.value)}
                        onBlur={() => void commit()}
                        onKeyDown={(event) => {
                           if (event.key === 'Enter') event.currentTarget.blur();
                           if (event.key === 'Escape') setName(me?.name ?? '');
                        }}
                     />
                  }
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
