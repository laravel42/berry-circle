'use client';

import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { AuthCard } from '@/components/auth/auth-card';
import { useSignOut } from '@/components/auth/use-sign-out';
import { Button } from '@/components/ui/button';
import {
   acceptInvitation,
   listMyInvitations,
   selectWorkspace,
   type WorkspaceInvitation,
} from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';

type State =
   | { kind: 'loading' }
   | { kind: 'ready'; invitation: WorkspaceInvitation }
   | { kind: 'unavailable' }
   | { kind: 'declined' }
   | { kind: 'failed' };

/**
 * One invitation, opened from its link.
 *
 * The states this can show are the states the server is willing to
 * distinguish, which is fewer than it first appears. `acceptInvitation`
 * answers every unusable invitation — wrong recipient, revoked, expired,
 * already accepted by someone else, never existed — with the same error, so
 * that a link cannot be used to find out whether an invitation exists or who
 * it was for. Inventing separate screens for those cases would mean guessing,
 * and guessing wrong in public.
 *
 * So this asks a different question instead: is this invitation in the list of
 * invitations open *for the signed-in account*? That list is authoritative and
 * safe, because it only ever contains the reader's own. If the invitation is
 * there, its workspace and role are shown and it can be accepted. If it is
 * not, the one honest thing to say is that it cannot be used by this account —
 * along with the two ways out: the reader's own workspaces, or signing in as
 * someone else, which is the usual cause.
 *
 * Declining is local. There is no decline endpoint, and inventing one that
 * silently revoked the invitation would take an action away from the person
 * who sent it; the invitation simply stays open until it expires.
 */
export default function InvitePage() {
   const t = useTranslations('workspaceAdmin.invite');
   const roles = useTranslations('workspaceAdmin.members');
   const { id } = useParams<{ id: string }>();
   const search = useSearchParams();
   const router = useRouter();
   const { signOut } = useSignOut();

   const status = useSessionStore((state) => state.status);
   const me = useSessionStore((state) => state.user);
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);

   const [state, setState] = useState<State>({ kind: 'loading' });
   const [accepting, setAccepting] = useState(false);

   // The token is only ever in the link. It is not required to accept an
   // invitation addressed to the signed-in account, but when it is present it
   // is passed along, so a link still works for someone whose account has the
   // invited address under a different login.
   const token = search.get('token');

   useEffect(() => {
      if (status !== 'ready') return;
      let cancelled = false;
      void listMyInvitations()
         .then((found) => {
            if (cancelled) return;
            const invitation = found.find((candidate) => candidate.id === id);
            setState(invitation ? { kind: 'ready', invitation } : { kind: 'unavailable' });
         })
         .catch(() => {
            if (!cancelled) setState({ kind: 'failed' });
         });
      return () => {
         cancelled = true;
      };
   }, [status, id]);

   const accept = async () => {
      setAccepting(true);
      try {
         const member = await acceptInvitation(id, token);
         await selectWorkspace(member.workspaceId).catch(() => undefined);
         const entered = await refreshWorkspaces().catch(() => null);
         router.replace(entered ? `/${entered.slug}/tasks` : '/onboarding');
      } catch {
         setState({ kind: 'unavailable' });
         setAccepting(false);
      }
   };

   if (status !== 'ready' || state.kind === 'loading') {
      return (
         <AuthCard title={t('checkingTitle')}>
            <p className="text-muted-foreground">{t('checking')}</p>
         </AuthCard>
      );
   }

   if (state.kind === 'declined') {
      return (
         <AuthCard title={t('declinedTitle')} description={t('declinedBody')}>
            <Button onClick={() => router.replace('/onboarding')}>{t('myWorkspaces')}</Button>
         </AuthCard>
      );
   }

   if (state.kind === 'ready') {
      const { invitation } = state;
      return (
         <AuthCard
            title={t('readyTitle', { workspace: invitation.workspaceName ?? '' })}
            description={t('readyBody', {
               role: roles(roleKey(invitation.role)),
               when: format(parseISO(invitation.expiresAt), 'd MMM yyyy'),
            })}
         >
            <div className="flex flex-col gap-2">
               <Button disabled={accepting} onClick={() => void accept()}>
                  {accepting ? t('accepting') : t('accept')}
               </Button>
               <Button
                  variant="secondary"
                  disabled={accepting}
                  onClick={() => setState({ kind: 'declined' })}
               >
                  {t('decline')}
               </Button>
            </div>
         </AuthCard>
      );
   }

   // `unavailable` and `failed` land here. They differ only in cause, and the
   // way out is the same.
   return (
      <AuthCard
         title={state.kind === 'failed' ? t('failedTitle') : t('unavailableTitle')}
         description={state.kind === 'failed' ? t('failedBody') : t('unavailableBody')}
      >
         <div className="flex flex-col gap-3">
            {me?.email ? (
               <p className="text-muted-foreground">{t('signedInAs', { email: me.email })}</p>
            ) : null}
            <Button asChild>
               <Link href="/onboarding">{t('myWorkspaces')}</Link>
            </Button>
            <Button variant="secondary" onClick={() => void signOut()}>
               {t('signInAsSomeoneElse')}
            </Button>
         </div>
      </AuthCard>
   );
}

/** The message key naming a role; an unknown value reads as member. */
function roleKey(role: string): 'role_owner' | 'role_admin' | 'role_member' | 'role_viewer' {
   switch (role) {
      case 'owner':
         return 'role_owner';
      case 'admin':
         return 'role_admin';
      case 'viewer':
         return 'role_viewer';
      default:
         return 'role_member';
   }
}
