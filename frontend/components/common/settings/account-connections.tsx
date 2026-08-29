'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   CHANNELS,
   addChannel,
   loadChannels,
   removeChannel,
   type ChannelIdentity,
} from '@/lib/settings';
import { Loader2, Mail, MessageCircle, Phone, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SelectMenu, SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Where Berry can reach you outside the product.
 *
 * This page used to offer Connect buttons for Slack, Notion and Google
 * Calendar — none of which existed. What is real is `user_channel_identities`:
 * an address per channel, one preferred per channel, none of them verified
 * yet.
 *
 * The unverified state is shown rather than hidden. An address someone typed
 * is a claim, Berry has no way to check it from here, and a list that looked
 * confirmed would be the wrong thing to trust when delivery starts.
 *
 * Connecting a *provider* — GitHub, so agents can push — is a workspace
 * decision and lives under Integrations. This is only about reaching you.
 */

const ICONS: Record<string, typeof Mail> = {
   EMAIL: Mail,
   SMS: Phone,
   WHATSAPP: MessageCircle,
   TELEGRAM: Send,
   VIBER: MessageCircle,
   LIVE_CHAT: MessageCircle,
};

const LABELS: Record<string, string> = {
   EMAIL: 'Email',
   SMS: 'SMS',
   WHATSAPP: 'WhatsApp',
   TELEGRAM: 'Telegram',
   VIBER: 'Viber',
   LIVE_CHAT: 'Live chat',
};

export default function AccountConnections() {
   const channels = useSettingsResource<ChannelIdentity[]>(loadChannels);
   const [channel, setChannel] = useState<string>('EMAIL');
   const [address, setAddress] = useState('');
   const [adding, setAdding] = useState(false);

   const add = async () => {
      const trimmed = address.trim();
      if (trimmed === '') return;
      setAdding(true);
      try {
         const saved = await addChannel({
            channel,
            address: trimmed,
            // The first address on a channel is the one to use; a later one is
            // an addition rather than a replacement unless someone says so.
            preferred: !(channels.value ?? []).some((entry) => entry.channel === channel),
         });
         channels.reload();
         setAddress('');
         toast.success(`${LABELS[saved.channel] ?? saved.channel} address added.`);
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'That could not be added.');
      } finally {
         setAdding(false);
      }
   };

   const remove = async (identity: ChannelIdentity) => {
      const rest = (channels.value ?? []).filter((entry) => entry.id !== identity.id);
      await channels.mutate(rest, () => removeChannel(identity.id));
   };

   return (
      <SettingsShell
         title="Connected accounts"
         description="Addresses Berry can reach you at. Connecting GitHub so agents can push is under Integrations."
      >
         <SettingsSection description={channels.error ?? undefined}>
            <SettingsCard>
               {channels.loading ? (
                  <SettingsRow title="Loading…" />
               ) : (channels.value ?? []).length === 0 ? (
                  <SettingsRow
                     title="No addresses yet"
                     description="Berry reaches you in your inbox until you add one."
                  />
               ) : (
                  (channels.value ?? []).map((identity) => {
                     const Icon = ICONS[identity.channel] ?? Mail;
                     return (
                        <SettingsRow
                           key={identity.id}
                           icon={<Icon className="size-4" />}
                           title={identity.address}
                           description={[
                              LABELS[identity.channel] ?? identity.channel,
                              identity.preferred ? 'preferred' : null,
                              // Said plainly: nothing verifies these yet, and a
                              // list that looked confirmed would be the wrong
                              // thing to trust when delivery starts.
                              identity.verified ? 'verified' : 'not verified',
                           ]
                              .filter(Boolean)
                              .join(' · ')}
                           trailing={
                              <Button
                                 size="xs"
                                 variant="ghost"
                                 className="text-status-danger hover:text-status-danger"
                                 disabled={channels.saving}
                                 onClick={() => void remove(identity)}
                              >
                                 Remove
                              </Button>
                           }
                        />
                     );
                  })
               )}
               <SettingsRow
                  title="Add an address"
                  trailing={
                     <span className="flex items-center gap-2">
                        <SelectMenu
                           options={[...CHANNELS].map((entry) => LABELS[entry] ?? entry)}
                           value={LABELS[channel] ?? channel}
                           disabled={adding}
                           onChange={(label) =>
                              setChannel(
                                 [...CHANNELS].find((entry) => (LABELS[entry] ?? entry) === label) ??
                                    'EMAIL'
                              )
                           }
                        />
                        <Input
                           value={address}
                           placeholder={channel === 'EMAIL' ? 'you@example.com' : '+1 555 0100'}
                           className="h-8 w-44"
                           onChange={(event) => setAddress(event.target.value)}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') void add();
                           }}
                        />
                        <Button
                           size="xs"
                           variant="ghost"
                           disabled={adding || address.trim() === ''}
                           onClick={() => void add()}
                        >
                           {adding ? <Loader2 className="size-3.5 animate-spin" /> : 'Add'}
                        </Button>
                     </span>
                  }
               />
            </SettingsCard>
         </SettingsSection>
      </SettingsShell>
   );
}
