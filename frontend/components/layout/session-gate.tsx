'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useSessionStore } from '@/store/session-store';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LocaleSync } from './locale-sync';

// Routes that must render for an anonymous visitor. `/login` is the legacy
// entry that forwards to `/sign-in`, the one sign-in page; keep it here so a
// 'ready' user landing on it is bounced into the app rather than left on a shim.
const AUTH_ROUTES = new Set(['/sign-in', '/login']);

function isAuthRoute(pathname: string): boolean {
   return AUTH_ROUTES.has(pathname);
}

function BootScreen() {
   return (
      <div className="flex min-h-svh items-center justify-center bg-background">
         <div className="flex items-center gap-2 text-muted-foreground">
            <BerryMark size="md" tone="brand" pulse label="Loading Berry" />
            <span>Loading Berry</span>
         </div>
      </div>
   );
}

export function SessionGate({ children }: { children: React.ReactNode }) {
   const pathname = usePathname();
   const router = useRouter();
   const status = useSessionStore((state) => state.status);
   const workspace = useSessionStore((state) => state.workspace);
   const hydrateFromStorage = useSessionStore((state) => state.hydrateFromStorage);

   useEffect(() => {
      void hydrateFromStorage();
   }, [hydrateFromStorage]);

   useEffect(() => {
      if (status === 'booting') return;

      const onAuthRoute = isAuthRoute(pathname);

      // Anonymous visitors may only see the auth routes; everything else sends
      // them to sign in.
      if (status === 'anonymous' && !onAuthRoute) {
         router.replace('/sign-in');
         return;
      }

      // A signed-in user has no business on an auth route — carry them into
      // their workspace.
      if (status === 'ready' && onAuthRoute) {
         router.replace(`/${workspace?.slug || WORKSPACE_SLUG}/tasks`);
      }
   }, [status, pathname, router, workspace?.slug]);

   if (status === 'booting') {
      return <BootScreen />;
   }

   return (
      <>
         <LocaleSync />
         {children}
      </>
   );
}
