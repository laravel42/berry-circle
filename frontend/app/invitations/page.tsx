'use client';

import { format, parseISO } from 'date-fns';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
   acceptInvitation,
   listMyInvitations,
   selectWorkspace,
   type WorkspaceInvitation,
} from '@/lib/workspaces';
import { useSessionStore } from '@/store/session-store';

/**
 * Every invitation waiting for you, across every workspace.
 *
 * Accepting them one at a time meant returning here after each, so several are
 * accepted together and you are put into the first of them — the one at the
 * top of the list, which is the most recent.
 *
 * The list only ever contains invitations that are open, unexpired and
 * addressed to the signed-in account: the server decides that, and a
 * invitation missing from it is one there is nothing useful to say about.
 */
export default function InvitationsPage() {
   const t = useTranslations('workspaceAdmin.invitations');
   const roles = useTranslations('workspaceAdmin.members');
   const router = useRouter();
   const status = useSessionStore((state) => state.status);
   const refreshWorkspaces = useSessionStore((state) => state.refreshWorkspaces);

   const [invitations, setInvitations] = useState<WorkspaceInvitation[] | null>(null);
   const [failed, setFailed] = useState(false);
   const [chosen, setChosen] = useState<Set<string>>(new Set());
   const [accepting, setAccepting] = useState(false);

   useEffect(() => {
      if (status !== 'ready') return;
      let cancelled = false;
      void listMyInvitations()
         .then((found) => {
            if (cancelled) return;
            setInvitations(found);
            // Everything waiting is selected: someone who opened this page
            // means to deal with what is on it, and unticking is easier than
            // ticking each one.
            setChosen(new Set(found.map((invitation) => invitation.id)));
         })
         .catch(() => {
            if (!cancelled) setFailed(true);
         });
      return () => {
         cancelled = true;
      };
   }, [status]);

   const toggle = (id: string) =>
      setChosen((current) => {
         const next = new Set(current);
         if (next.has(id)) next.delete(id);
         else next.add(id);
         return next;
      });

   const acceptChosen = useCallback(async () => {
      const list = (invitations ?? []).filter((invitation) => chosen.has(invitation.id));
      if (list.length === 0) return;
      setAccepting(true);

      // One at a time, keeping the order on screen, so "the first accepted"
      // means the first one listed rather than whichever call returned first.
      let first: string | null = null;
      let refused = 0;
      for (const invitation of list) {
         try {
            const member = await acceptInvitation(invitation.id, null);
            first ??= member.workspaceId;
         } catch {
            refused += 1;
         }
      }

      if (first === null) {
         setAccepting(false);
         toast.error(t('acceptFailed'));
         return;
      }
      // Some accepted and some did not: say so before leaving, or the ones
      // that failed would vanish without explanation.
      if (refused > 0) toast.error(t('someFailed', { count: refused }));

      await selectWorkspace(first).catch(() => undefined);
      const entered = await refreshWorkspaces().catch(() => null);
      router.replace(entered ? `/${entered.slug}/tasks` : '/onboarding');
   }, [invitations, chosen, refreshWorkspaces, router, t]);

   if (status !== 'ready' || (invitations === null && !failed)) {
      return (
         <div className="flex min-h-svh items-center justify-center bg-background">
            <div className="flex items-center gap-2 text-muted-foreground">
               <BerryMark size="md" tone="brand" pulse label={t('loading')} />
               <span>{t('loading')}</span>
            </div>
         </div>
      );
   }

   const list = invitations ?? [];

   return (
      <div className="flex min-h-svh justify-center bg-background px-6 py-16">
         <div className="w-full max-w-xl">
            <h1 className="font-display tracking-[-0.025em]">{t('title')}</h1>
            <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>

            {failed ? (
               <p role="alert" className="mt-8 text-status-danger">
                  {t('loadFailed')}
               </p>
            ) : null}

            {!failed && list.length === 0 ? (
               <div className="mt-8 rounded-lg border bg-container px-4 py-6">
                  <p className="font-medium">{t('empty')}</p>
                  <p className="mt-1 text-muted-foreground">{t('emptyHint')}</p>
               </div>
            ) : null}

            {list.length > 0 ? (
               <>
                  <ul className="mt-8 divide-y divide-border/60 rounded-lg border bg-container">
                     {list.map((invitation) => (
                        <li key={invitation.id} className="flex items-center gap-3 px-4 py-3">
                           <Checkbox
                              checked={chosen.has(invitation.id)}
                              disabled={accepting}
                              aria-label={invitation.workspaceName ?? invitation.workspaceId}
                              onCheckedChange={() => toggle(invitation.id)}
                           />
                           <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">
                                 {invitation.workspaceName ?? invitation.workspaceId}
                              </div>
                              <div className="text-muted-foreground">
                                 {[
                                    roles(roleKey(invitation.role)),
                                    t('expires', {
                                       when: format(parseISO(invitation.expiresAt), 'd MMM yyyy'),
                                    }),
                                 ].join(' · ')}
                              </div>
                           </div>
                        </li>
                     ))}
                  </ul>

                  <div className="mt-4 flex items-center justify-between gap-3">
                     <Link href="/onboarding" className="text-muted-foreground hover:underline">
                        {t('myWorkspaces')}
                     </Link>
                     <Button
                        disabled={accepting || chosen.size === 0}
                        onClick={() => void acceptChosen()}
                     >
                        {accepting ? t('accepting') : t('accept', { count: chosen.size })}
                     </Button>
                  </div>
               </>
            ) : (
               <div className="mt-4">
                  <Link href="/onboarding" className="text-muted-foreground hover:underline">
                     {t('myWorkspaces')}
                  </Link>
               </div>
            )}
         </div>
      </div>
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
