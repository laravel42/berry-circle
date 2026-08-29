'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
   createToken,
   describeDevice,
   loadSessions,
   loadTokens,
   revokeSession,
   revokeToken,
   type AccountSession,
   type PersonalToken,
} from '@/lib/settings';
import { KeyRound, Loader2, Monitor } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Security & access": where this account is signed in, and the keys
 * that can act as it.
 *
 * The passkey and commit-signing sections this page used to show are gone.
 * Berry has neither, and a button that opens nothing on a security page is
 * worse than an absent one — it suggests a protection that is not there.
 */
export default function AccountSecurity() {
   const sessions = useSettingsResource<AccountSession[]>(loadSessions);
   const tokens = useSettingsResource<PersonalToken[]>(loadTokens);
   const [creating, setCreating] = useState(false);
   const [name, setName] = useState('');
   /** Shown once. The server keeps a hash, so this is the only time it exists. */
   const [secret, setSecret] = useState<string | null>(null);

   const signOut = async (session: AccountSession) => {
      const rest = (sessions.value ?? []).filter((entry) => entry.id !== session.id);
      await sessions.mutate(rest, () => revokeSession(session.id));
   };

   const create = async () => {
      const trimmed = name.trim();
      if (trimmed === '') return;
      setCreating(true);
      try {
         const { secret: issued, record } = await createToken(trimmed);
         tokens.set([record, ...(tokens.value ?? [])]);
         setName('');
         setSecret(issued);
         if (!issued) toast.error('That key already existed; its secret cannot be shown again.');
      } catch (cause) {
         toast.error(cause instanceof Error ? cause.message : 'The key could not be created.');
      } finally {
         setCreating(false);
      }
   };

   const revoke = async (token: PersonalToken) => {
      const rest = (tokens.value ?? []).filter((entry) => entry.id !== token.id);
      await tokens.mutate(rest, () => revokeToken(token.id));
   };

   return (
      <SettingsShell title="Security & access">
         <SettingsSection
            title="Sessions"
            description={sessions.error ?? 'Devices signed in to your account'}
         >
            <SettingsCard>
               {sessions.loading ? (
                  <SettingsRow title="Loading…" />
               ) : (sessions.value ?? []).length === 0 ? (
                  <SettingsRow title="No other sessions" />
               ) : (
                  (sessions.value ?? []).map((session) => (
                     <SettingsRow
                        key={session.id}
                        icon={<Monitor className="size-4" />}
                        title={describeDevice(session.userAgent)}
                        description={[session.ip, `last used ${when(session.lastUsedAt ?? session.createdAt)}`]
                           .filter(Boolean)
                           .join(' · ')}
                        trailing={
                           <Button
                              size="xs"
                              variant="ghost"
                              disabled={sessions.saving}
                              onClick={() => void signOut(session)}
                           >
                              Sign out
                           </Button>
                        }
                     />
                  ))
               )}
            </SettingsCard>
         </SettingsSection>

         <SettingsSection
            title="Personal API keys"
            description={tokens.error ?? 'Use the API to build your own integrations'}
         >
            <SettingsCard>
               {(tokens.value ?? []).map((token) => (
                  <SettingsRow
                     key={token.id}
                     icon={<KeyRound className="size-4" />}
                     title={token.name}
                     description={`${token.prefix}… · ${
                        token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : 'never used'
                     }`}
                     trailing={
                        <Button
                           size="xs"
                           variant="ghost"
                           className="text-status-danger hover:text-status-danger"
                           disabled={tokens.saving}
                           onClick={() => void revoke(token)}
                        >
                           Revoke
                        </Button>
                     }
                  />
               ))}
               <SettingsRow
                  title={(tokens.value ?? []).length === 0 ? 'No API keys' : 'New key'}
                  trailing={
                     <span className="flex items-center gap-2">
                        <Input
                           value={name}
                           placeholder="What is it for?"
                           className="h-8 w-44"
                           onChange={(event) => setName(event.target.value)}
                           onKeyDown={(event) => {
                              if (event.key === 'Enter') void create();
                           }}
                        />
                        <Button
                           size="xs"
                           variant="ghost"
                           disabled={creating || name.trim() === ''}
                           onClick={() => void create()}
                        >
                           {creating ? <Loader2 className="size-3.5 animate-spin" /> : 'Create'}
                        </Button>
                     </span>
                  }
               />
            </SettingsCard>
            {secret ? (
               <div className="mt-2 rounded-md border border-status-warning/40 bg-container px-4 py-3">
                  <p className="font-medium">Copy this now — it is not shown again.</p>
                  <code className="mt-1.5 block break-all font-mono text-muted-foreground">
                     {secret}
                  </code>
                  <Button
                     size="xs"
                     variant="ghost"
                     className="mt-2 -ml-2"
                     onClick={() => {
                        void navigator.clipboard?.writeText(secret);
                        setSecret(null);
                     }}
                  >
                     Copy and dismiss
                  </Button>
               </div>
            ) : null}
         </SettingsSection>
      </SettingsShell>
   );
}

/** "3 days ago", roughly. A security page needs recency, not a timestamp. */
function when(iso: string): string {
   const then = Date.parse(iso);
   if (Number.isNaN(then)) return 'unknown';
   const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
   if (minutes < 1) return 'just now';
   if (minutes < 60) return `${minutes}m ago`;
   const hours = Math.round(minutes / 60);
   if (hours < 24) return `${hours}h ago`;
   const days = Math.round(hours / 24);
   return days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
}
