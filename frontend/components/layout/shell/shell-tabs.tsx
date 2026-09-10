'use client';

import { useEffect, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { shellIconButton } from './shell-icon';
import type { ShellTab } from '@/store/shell-store';
import { BerryMark } from './shell-icon';
import { useTranslations } from 'next-intl';
import { SHELL_ROUTES } from './shell-routes';

interface ShellTabsProps {
   tabs: ShellTab[];
   activeTabId: string | null;
   onActivate: (tab: ShellTab) => void;
   onClose: (id: string) => void;
   onNew: () => void;
}

/**
 * The tab strip, ported from `Berry Prototype.dc.html`.
 *
 * Each tab's close control is a real button rather than a click handler on a
 * span, which makes it keyboard-reachable. That is also why the tab itself is a
 * button and not a wrapping anchor: nesting an interactive element inside a
 * link is invalid and breaks activation for both.
 */
export function ShellTabs({ tabs, activeTabId, onActivate, onClose, onNew }: ShellTabsProps) {
   const stripRef = useRef<HTMLDivElement>(null);
   const activeRef = useRef<HTMLDivElement>(null);

   // The strip scrolls, so an active tab opened beyond the fold would otherwise
   // be selected but invisible.
   useEffect(() => {
      activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
   }, [activeTabId]);

   const t = useTranslations('shell');
   // Tabs persist their English label; a rail destination is re-labelled at
   // render so switching language renames open tabs too. Detail tabs (an issue
   // key, "projects / abc") keep what they stored.
   const labelOf = (tab: ShellTab) => {
      const route = SHELL_ROUTES.find((candidate) => candidate.href === tab.href);
      return route ? t(`nav.${route.labelKey}`) : tab.label;
   };

   return (
      <div
         ref={stripRef}
         role="tablist"
         aria-label={t('tabs.openViews')}
         className="tabstrip flex h-[34px] min-w-0 flex-1 items-stretch overflow-x-auto bg-[var(--shell-rail)]"
      >
         {tabs.map((tab) => {
            const on = tab.id === activeTabId;
            const label = labelOf(tab);
            return (
               <div
                  key={tab.id}
                  ref={on ? activeRef : undefined}
                  className={[
                     'group flex h-[33px] min-w-24 max-w-[180px] flex-none items-center gap-2 pr-1.5 pl-3 transition-colors',
                     on
                        ? 'bg-[var(--shell-canvas)] text-[var(--shell-text)]'
                        : 'bg-[var(--shell-rail)] text-[var(--shell-text-muted)] hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]',
                  ].join(' ')}
               >
                  <button
                     type="button"
                     role="tab"
                     aria-selected={on}
                     onClick={() => onActivate(tab)}
                     onAuxClick={(event) => {
                        // Middle-click closes, as in a browser.
                        if (event.button === 1) {
                           event.preventDefault();
                           onClose(tab.id);
                        }
                     }}
                     title={label}
                     className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                     <BerryMark size={13} muted />
                     <span className="truncate">{label}</span>
                  </button>
                  <button
                     type="button"
                     onClick={() => onClose(tab.id)}
                     aria-label={t('tabs.close', { label })}
                     className={[
                        // Unfilled until hovered: a filled square on every tab
                        // would read as a row of dismiss buttons.
                        'flex size-[18px] flex-none cursor-pointer items-center justify-center rounded-[3px]',
                        'text-[var(--shell-text-dim)] transition-colors',
                        'hover:bg-[var(--shell-line-strong)] hover:text-[var(--shell-text)]',
                        // Keep the close affordance quiet until the tab is
                        // hovered or active, so a full strip does not read as a
                        // row of dismiss buttons. Focus reveals it for keyboard
                        // users, who get no hover.
                        on ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                     ].join(' ')}
                  >
                     <X size={14} strokeWidth={1.8} aria-hidden="true" />
                  </button>
               </div>
            );
         })}
         <button
            type="button"
            onClick={onNew}
            aria-label={t('tabs.newTab')}
            className={`my-[3.5px] mx-1 size-[26px] ${shellIconButton}`}
         >
            <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
         </button>
      </div>
   );
}
