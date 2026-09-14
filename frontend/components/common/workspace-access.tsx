'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

import { useSignOut } from '@/components/auth/use-sign-out';
import { BerryMark } from '@/components/brand/berry-mark';
import { Button } from '@/components/ui/button';
import { useSessionStore } from '@/store/session-store';

/**
 * What a workspace route shows when the address is not one the reader can open.
 *
 * There are two reasons for that and they must be indistinguishable: the
 * workspace does not exist, or it exists and this account is not in it. The
 * server already holds that line — the workspace guard answers the same 404 for
 * both — and a page that said "no such workspace" would hand it back, letting
 * anyone test slugs until one answered differently. So this says only that the
 * address cannot be opened *by this account*, and offers the two things that
 * actually help: the workspaces the reader does have, and signing in as
 * somebody else, which is the usual cause.
 *
 * The one case that must not reach this screen is leaving or deleting a
 * workspace you were just in. The slug is still in the URL for the moment it
 * takes to route away, and flashing "you cannot open this" at somebody who has
 * just pressed Leave reads as an error rather than as the thing they asked
 * for. So a slug this session has seen in the reader's own list is treated as a
 * departure: it routes onward quietly instead of rendering anything.
 */
export function WorkspaceAccess({ children }: { children: React.ReactNode }) {
   const t = useTranslations('workspaceAdmin.noAccess');
   const router = useRouter();
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId ?? '';
   const { signOut } = useSignOut();

   const status = useSessionStore((state) => state.status);
   const workspaces = useSessionStore((state) => state.workspaces);
   const me = useSessionStore((state) => state.user);

   const belongs = workspaces.some((workspace) => workspace.slug === orgId);
   // Remembered rather than derived: once it is gone from the list, the only
   // evidence that it was ever the reader's is that this session saw it.
   const seen = useRef(new Set<string>());
   if (belongs && orgId) seen.current.add(orgId);
   const departed = !belongs && seen.current.has(orgId);

   useEffect(() => {
      if (status !== 'ready' || belongs || !departed) return;
      const next = workspaces[0];
      router.replace(next ? `/${next.slug}/tasks` : '/onboarding');
   }, [status, belongs, departed, workspaces, router]);

   // While the session is still loading, nothing is known yet — and an
   // anonymous reader is the sign-in flow's business, not this screen's.
   if (status !== 'ready' || belongs || departed) return <>{children}</>;

   return (
      <div className="flex min-h-svh items-center justify-center bg-background px-6 py-16">
         <div className="w-full max-w-md text-center">
            <BerryMark size="lg" tone="neutral" state="crossed" label={t('title')} />
            <h1 className="mt-5 font-display tracking-[-0.025em]">{t('title')}</h1>
            <p className="mt-2 leading-relaxed text-muted-foreground">{t('body')}</p>
            {me?.email ? (
               <p className="mt-4 text-muted-foreground">{t('signedInAs', { email: me.email })}</p>
            ) : null}
            <div className="mt-6 flex flex-col gap-2">
               <Button asChild>
                  <Link href={workspaces[0] ? `/${workspaces[0].slug}/tasks` : '/onboarding'}>
                     {t('myWorkspaces')}
                  </Link>
               </Button>
               <Button variant="secondary" onClick={() => void signOut()}>
                  {t('signInAsSomeoneElse')}
               </Button>
            </div>
         </div>
      </div>
   );
}
