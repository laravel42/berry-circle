'use client';

import { Button } from '@/components/ui/button';
import { describeDevice, loadSessions, revokeSession, type AccountSession } from '@/lib/settings';
import { Monitor } from 'lucide-react';
import { SettingsCard, SettingsRow, SettingsSection, SettingsShell } from './shared';
import { useSettingsResource } from './use-settings-resource';

/**
 * Personal "Security & access": where this account is signed in.
 *
 * The passkey and commit-signing sections this page used to show are gone.
 * Berry has neither, and a button that opens nothing on a security page is
 * worse than an absent one — it suggests a protection that is not there.
 *
 * API keys moved to their own page. They had grown a creation form with an
 * expiry, a scope picker and a one-time secret to hand over carefully, which
 * is a page's worth of decisions rather than a section under a device list.
 */
export default function AccountSecurity() {
   const sessions = useSettingsResource<AccountSession[]>(loadSessions);

   const signOut = async (session: AccountSession) => {
      const rest = (sessions.value ?? []).filter((entry) => entry.id !== session.id);
      await sessions.mutate(rest, () => revokeSession(session.id));
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
                        description={[
                           session.ip,
                           `last used ${when(session.lastUsedAt ?? session.createdAt)}`,
                        ]
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
