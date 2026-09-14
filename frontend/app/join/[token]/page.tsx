'use client';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { BerryApiError } from '@/lib/api';
import { acceptJoinLink, lookupJoinLink } from '@/lib/join-links';
import { selectWorkspace } from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

type State =
   | { kind: 'loading' }
   | { kind: 'invalid' }
   | { kind: 'ready'; workspace: string; role: string }
   | { kind: 'signin' }
   | { kind: 'error' };

/**
 * Public landing for a join link: shows the workspace, then joins it.
 *
 * The preview is the one unauthenticated read in Berry, so somebody who was
 * sent a link can see what they are being asked to join before signing in.
 *
 * Joining twice is not an error. The server answers `joined: false` for
 * somebody who is already a member, which is the right answer — the outcome
 * they wanted is already true — so this enters the workspace either way and
 * says which of the two happened, rather than sending both to the same silent
 * redirect.
 */
export default function JoinPage() {
   const t = useTranslations('workspaceAdmin.join');
   const { token } = useParams<{ token: string }>();
   const router = useRouter();
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);
   const [state, setState] = useState<State>({ kind: 'loading' });
   const [joining, setJoining] = useState(false);

   useEffect(() => {
      void lookupJoinLink(token)
         .then((found) =>
            setState({ kind: 'ready', workspace: found.workspace.name, role: found.role })
         )
         .catch(() => setState({ kind: 'invalid' }));
   }, [token]);

   const join = async () => {
      setJoining(true);
      try {
         const result = await acceptJoinLink(token);
         await selectWorkspace(result.workspaceId).catch(() => undefined);
         const entered = await refreshWorkspaces().catch(() => null);
         router.replace(entered ? `/${entered.slug}/tasks` : '/');
      } catch (cause) {
         setState(
            cause instanceof BerryApiError && cause.status === 401
               ? { kind: 'signin' }
               : { kind: 'error' }
         );
         setJoining(false);
      }
   };

   return (
      <AuthCard title={t('title')}>
         {state.kind === 'loading' ? (
            <p className="text-muted-foreground">{t('checking')}</p>
         ) : null}
         {state.kind === 'invalid' ? <p>{t('invalid')}</p> : null}
         {state.kind === 'ready' ? (
            <div className="flex flex-col gap-4">
               <p>{t('offer', { workspace: state.workspace, role: state.role })}</p>
               <Button onClick={() => void join()} disabled={joining}>
                  {joining ? t('joining') : t('join')}
               </Button>
               {/* Somebody already in here followed the link anyway. Joining
                   takes them in rather than refusing something that is
                   already true. */}
               <p className="text-muted-foreground">{t('alreadyMember')}</p>
            </div>
         ) : null}
         {state.kind === 'signin' ? (
            <p>
               <Link className="underline" href="/sign-in">
                  {t('signIn')}
               </Link>{' '}
               {t('signInRest')}
            </p>
         ) : null}
         {state.kind === 'error' ? <p>{t('failed')}</p> : null}
      </AuthCard>
   );
}
