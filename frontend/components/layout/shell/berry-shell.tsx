'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { INDEX_TAB, useShellStore, type ShellTab } from '@/store/shell-store';
import { activeShellRoute, type ShellRoute } from './shell-routes';
import { describeRoute } from './shell-tab-model';
import { ShellRail } from './shell-rail';
import { ShellTabs } from './shell-tabs';
import { shellIconButton } from './shell-icon';
import { NotificationBell } from '../notifications/notification-bell';
import { NotificationsDrawer } from '../notifications/notifications-drawer';
import { NotificationToasts } from '../notifications/notification-toasts';
import { ShortcutProvider } from '../shortcut-provider';
import { NavigationProgress } from '../navigation-progress';
import { ShellShortcuts } from './shell-shortcuts';

/**
 * The application shell from `Berry Prototype.dc.html`: a collapsible rail, a
 * browser-style tab strip, and the workspace canvas.
 *
 * The active tab shows the current URL. Everything follows from that:
 * navigating anywhere — a rail item, a link in the page, browser back, a deep
 * link — changes what the active tab displays rather than opening a new one,
 * which is why a rail click replaces the current view. Opening an additional
 * tab is the one action that is explicit, via "+".
 */
export function BerryShell({ children }: { children: React.ReactNode }) {
   const pathname = usePathname() ?? '';
   const search = useSearchParams()?.toString() ?? '';
   const params = useParams<{ orgId?: string }>();
   const orgId = params?.orgId ?? '';
   const router = useRouter();

   const {
      tabs,
      activeTabId,
      railOpen,
      showInActiveTab,
      openTab,
      activateTab,
      closeTab,
      toggleRail,
   } = useShellStore();

   // describeRoute is pure, so memoising gives the effect below a stable
   // dependency instead of a fresh object every render.
   const current = useMemo(() => describeRoute(pathname, orgId), [pathname, orgId]);
   const activeRoute: ShellRoute | null = activeShellRoute(pathname, search);
   // Settings replaces the rail's contents rather than sitting inside it, the
   // way AppSidebar swapped its whole body on settings routes.
   const settingsMode = pathname.includes('/settings');

   // The URL is the source of truth; the active tab follows it.
   useEffect(() => {
      if (current) showInActiveTab(current.href, current.label);
   }, [current, showInActiveTab]);

   const push = useCallback((href: string) => router.push(`/${orgId}${href}`), [orgId, router]);

   const handleActivate = useCallback(
      (tab: ShellTab) => {
         activateTab(tab.id);
         push(tab.href);
      },
      [activateTab, push]
   );

   const handleClose = useCallback(
      (id: string) => {
         const next = closeTab(id);
         if (next) push(next.href);
      },
      [closeTab, push]
   );

   // "+" opens an additional tab on the index route, even when a tab is
   // already showing it — the same as a browser opening a second homepage.
   const handleNew = useCallback(() => {
      openTab(INDEX_TAB.href, INDEX_TAB.label);
      push(INDEX_TAB.href);
   }, [openTab, push]);

   // Browser-style shortcuts. Ctrl rather than Cmd, so the bindings do not
   // collide with Safari and Chrome's own tab shortcuts on macOS.
   useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
         if (!event.ctrlKey || event.metaKey || event.altKey) return;
         const index = tabs.findIndex((tab) => tab.id === activeTabId);

         if (event.key === 't') {
            event.preventDefault();
            handleNew();
            return;
         }
         if (event.key === 'w' && activeTabId) {
            event.preventDefault();
            handleClose(activeTabId);
            return;
         }
         if (event.key === 'Tab' && tabs.length > 1) {
            event.preventDefault();
            const step = event.shiftKey ? -1 : 1;
            const from = index === -1 ? 0 : index;
            handleActivate(tabs[(from + step + tabs.length) % tabs.length]);
         }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
   }, [tabs, activeTabId, handleNew, handleClose, handleActivate]);

   return (
      <ShortcutProvider>
         <ShellShortcuts orgId={orgId} />
         <div className="grid h-screen w-screen grid-cols-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--shell-surface)] font-mono font-light text-[var(--shell-text)]">
            {railOpen ? (
               <ShellRail
                  orgId={orgId}
                  active={activeRoute}
                  onToggle={toggleRail}
                  settingsMode={settingsMode}
               />
            ) : (
               <button
                  type="button"
                  onClick={toggleRail}
                  aria-label="Expand sidebar"
                  className="flex w-9 flex-none items-start justify-center bg-[var(--shell-rail)] pt-4"
               >
                  <span className={`size-[26px] ${shellIconButton}`}>
                     {/* Mirrors the collapse control at the foot of the rail. */}
                     <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.7}
                     >
                        <path d="M10 6l5 6-5 6" />
                     </svg>
                  </span>
               </button>
            )}

            <div className="relative flex h-[100vh] max-h-[100vh] min-w-0 flex-col overflow-hidden border-l border-[var(--shell-line)]">
               <NavigationProgress />
               {/* The bell sits outside the strip, which scrolls: an unread
                count that can scroll out of view is not a count. */}
               <div className="flex h-[34px] flex-none items-stretch bg-[var(--shell-rail)]">
                  <ShellTabs
                     tabs={tabs}
                     activeTabId={activeTabId}
                     onActivate={handleActivate}
                     onClose={handleClose}
                     onNew={handleNew}
                  />
                  <NotificationBell />
               </div>
               <main className="min-h-0 flex-1 overflow-auto bg-[var(--shell-canvas)]">
                  {children}
               </main>
               <NotificationsDrawer />
               <NotificationToasts />
            </div>
         </div>
      </ShortcutProvider>
   );
}
