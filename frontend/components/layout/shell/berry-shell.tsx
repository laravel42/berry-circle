'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useShellStore } from '@/store/shell-store';
import { activeShellRoute, type ShellRoute } from './shell-routes';
import { describeTab, type ShellTab } from './shell-tab-model';
import { ShellRail } from './shell-rail';
import { ShellTabs } from './shell-tabs';

/** Where the strip lands when the last tab is closed, per the prototype. */
const HOME: ShellTab = { key: 'issues', label: 'issues', href: '/my-issues' };

/**
 * The application shell from `Berry Prototype.dc.html`: a collapsible rail, a
 * browser-style tab strip, and the workspace canvas.
 *
 * The URL is the source of truth for what is displayed; tabs are chrome layered
 * on top. Tabs therefore follow navigation rather than driving it — arriving
 * anywhere, by any means, opens a tab for it, so a deep link, a browser back,
 * or a refresh all land on the right view whatever the stored tabs say.
 */
export function BerryShell({ children }: { children: React.ReactNode }) {
   const pathname = usePathname() ?? '';
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId ?? '';
   const router = useRouter();
   const { tabs, railOpen, openTab, closeTab, toggleRail } = useShellStore();

   // describeTab is pure, so memoising gives the effect below a stable
   // dependency instead of a fresh object every render.
   const current = useMemo(() => describeTab(pathname, orgId), [pathname, orgId]);
   const activeKey = current?.key ?? null;
   const activeRoute: ShellRoute | null = activeShellRoute(pathname);

   // Navigation opens tabs, never the reverse. Depending on the derived key and
   // label rather than the object keeps this from firing every render.
   useEffect(() => {
      if (current) openTab(current);
   }, [current, openTab]);

   const navigate = useCallback(
      (tab: ShellTab) => router.push(`/${orgId}${tab.href}`),
      [orgId, router],
   );

   const handleClose = useCallback(
      (key: string) => {
         const next = closeTab(key, activeKey);
         // Closing the active tab moves left; emptying the strip returns home.
         if (next) navigate(next);
         else if (key === activeKey) navigate(HOME);
      },
      [activeKey, closeTab, navigate],
   );

   // Browser-style shortcuts. Ctrl is used rather than Cmd so the bindings do
   // not collide with Safari and Chrome's own tab shortcuts on macOS.
   useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
         if (!event.ctrlKey || event.metaKey || event.altKey) return;
         const index = tabs.findIndex((tab) => tab.key === activeKey);

         if (event.key === 'w' && activeKey) {
            event.preventDefault();
            handleClose(activeKey);
            return;
         }
         if (event.key === 'Tab' && tabs.length > 1) {
            event.preventDefault();
            const step = event.shiftKey ? -1 : 1;
            const from = index === -1 ? 0 : index;
            navigate(tabs[(from + step + tabs.length) % tabs.length]);
         }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [tabs, activeKey, handleClose, navigate]);

   return (
      <div className="grid h-screen w-screen grid-cols-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--shell-surface)] font-mono text-[10px] font-light text-[var(--shell-text)]">
         {railOpen ? (
            <ShellRail orgId={orgId} active={activeRoute} onToggle={toggleRail} />
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
               activeKey={activeKey}
               onActivate={navigate}
               onClose={handleClose}
               onNew={() => navigate(HOME)}
            />
            <main className="min-h-0 flex-1 overflow-auto bg-[var(--shell-canvas)]">{children}</main>
         </div>
      </div>
   );
}
