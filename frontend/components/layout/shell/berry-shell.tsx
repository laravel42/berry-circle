'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useShellStore } from '@/store/shell-store';
import { activeShellRoute, shellRoute, type ShellRoute } from './shell-routes';
import { ShellRail } from './shell-rail';
import { ShellTabs } from './shell-tabs';

/**
 * The application shell from `Berry Prototype.dc.html`: a collapsible rail, a
 * browser-style tab strip, and the workspace canvas.
 *
 * The URL stays the source of truth for what is displayed; the tab list is
 * only chrome layered on top. Tabs therefore follow navigation rather than
 * driving it — arriving anywhere, by any means, opens a tab for it, and a
 * deep link or a refresh lands on the right view whatever the stored tabs say.
 */
export function BerryShell({ orgId, children }: { orgId: string; children: React.ReactNode }) {
   const pathname = usePathname();
   const router = useRouter();
   const { tabs, railOpen, openTab, closeTab, toggleRail } = useShellStore();
   const active = activeShellRoute(pathname ?? '');

   // Navigation opens tabs, never the reverse. Running on `active` alone keeps
   // this from firing on every render while still catching deep links.
   useEffect(() => {
      if (active) openTab(active);
   }, [active, openTab]);

   const navigate = (route: ShellRoute) => {
      const target = shellRoute(route);
      if (target) router.push(`/${orgId}${target.href}`);
   };

   const handleClose = (route: ShellRoute) => {
      const next = closeTab(route, active);
      if (next) navigate(next);
   };

   return (
      <div className="grid h-screen w-screen grid-cols-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--shell-surface)] font-mono text-[10px] font-light text-[var(--shell-text)]">
         {railOpen ? (
            <ShellRail
               orgId={orgId}
               active={active}
               onToggle={toggleRail}
               onNavigate={openTab}
            />
         ) : (
            <button
               type="button"
               onClick={toggleRail}
               aria-label="Expand sidebar"
               className="flex w-9 flex-none items-start justify-center bg-[var(--shell-rail)] pt-4 text-[var(--shell-text-dim)] transition-colors hover:text-[var(--shell-text)]"
            >
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                  <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
               </svg>
            </button>
         )}

         <div className="relative flex min-w-0 flex-col overflow-hidden border-l border-[var(--shell-line)]">
            <ShellTabs
               tabs={tabs}
               active={active}
               onActivate={navigate}
               onClose={handleClose}
               onNew={() => navigate('issues')}
            />
            <main className="min-h-0 flex-1 overflow-auto bg-[var(--shell-canvas)]">
               {children}
            </main>
         </div>
      </div>
   );
}
