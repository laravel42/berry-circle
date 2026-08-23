'use client';

import { BerryMark } from '@/components/brand/berry-mark';
import { WORKSPACE_SLUG } from '@/lib/config';
import { useSessionStore } from '@/store/session-store';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

function BootScreen() {
   return (
      <div className="flex min-h-svh items-center justify-center bg-background">
         <div className="flex items-center gap-2 text-muted-foreground">
            <BerryMark size="md" tone="brand" pulse label="Loading Berry" />
            <span className="text-sm">Loading Berry</span>
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
      if (status === 'ready' && pathname === '/login') {
         router.replace(`/${workspace?.slug || WORKSPACE_SLUG}/runs`);
      }
   }, [status, pathname, router, workspace?.slug]);

   if (status === 'booting') {
      return <BootScreen />;
   }

   return children;
}
