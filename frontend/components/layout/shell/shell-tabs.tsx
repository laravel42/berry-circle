'use client';

import { shellRoute, type ShellRoute } from './shell-routes';
import { BerryMark } from './shell-icon';

interface ShellTabsProps {
   tabs: ShellRoute[];
   active: ShellRoute | null;
   onActivate: (route: ShellRoute) => void;
   onClose: (route: ShellRoute) => void;
   onNew: () => void;
}

/**
 * The tab strip, ported from `Berry Prototype.dc.html`.
 *
 * Each tab's close control is a real button rather than a click handler on a
 * span. That is what makes it keyboard-reachable, and it is why the tab itself
 * is a button and not a wrapping anchor: nesting an interactive element inside
 * a link is invalid and breaks activation for both.
 */
export function ShellTabs({ tabs, active, onActivate, onClose, onNew }: ShellTabsProps) {
   return (
      <div
         role="tablist"
         aria-label="Open views"
         className="tabstrip flex h-[34px] flex-none items-stretch overflow-x-auto"
      >
         {tabs.map((tab) => {
            const on = tab === active;
            const label = shellRoute(tab)?.label ?? tab;
            return (
               <div
                  key={tab}
                  className={[
                     'flex h-[33px] min-w-24 max-w-[180px] flex-none items-center gap-2 pr-2.5 pl-3 text-[11px] transition-colors',
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
                     className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                     <BerryMark size={13} muted />
                     <span className="truncate">{label}</span>
                  </button>
                  <button
                     type="button"
                     onClick={() => onClose(tab)}
                     aria-label={`Close ${label}`}
                     className="cursor-pointer px-[3px] text-[var(--shell-text-dim)] transition-colors hover:text-[var(--shell-text)]"
                  >
                     &times;
                  </button>
               </div>
            );
         })}
         <button
            type="button"
            onClick={onNew}
            aria-label="New tab"
            className="flex h-[33px] w-[30px] flex-none cursor-pointer items-center justify-center text-[11px] text-[var(--shell-text-dim)] transition-colors hover:bg-[var(--shell-hover)] hover:text-[var(--shell-text)]"
         >
            +
         </button>
      </div>
   );
}
